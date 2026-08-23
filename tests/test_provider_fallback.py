import asyncio
import importlib
import pathlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

from test_support import install_api_manager_stubs


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "shoubanhua_test_package"


def load_api_manager():
    if PACKAGE not in sys.modules:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package

    install_api_manager_stubs()

    return importlib.import_module(f"{PACKAGE}.api_manager").ApiManager


class ProviderFallbackTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.ApiManager = load_api_manager()

    def setUp(self):
        self.config = {
            "model_providers": [
                {
                    "name": "主提供商",
                    "enabled": True,
                    "interface_mode": "openai_chat",
                    "base_url": "https://primary.example.com",
                    "api_keys": "primary-key",
                    "model": "primary-model",
                    "text_to_image_model": "primary-text-model",
                },
                {
                    "name": "备用提供商",
                    "enabled": True,
                    "interface_mode": "gemini_official",
                    "base_url": "https://backup.example.com",
                    "api_keys": "backup-key",
                    "model": "backup-model",
                    "text_to_image_model": "backup-text-model",
                },
            ]
        }
        self.manager = self.ApiManager(self.config)

    async def asyncTearDown(self):
        await self.manager.close()

    async def test_failure_falls_back_to_next_provider(self):
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value="API Error 500: 主站故障"),
            get_last_metrics=lambda: {"total_duration": 0.2},
        )
        backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"image-data"),
            get_last_metrics=lambda: {"total_duration": 0.3},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[primary, backup]),
        ):
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"image-data")
        self.assertEqual(primary.call_api.await_count, 1)
        self.assertEqual(backup.call_api.await_count, 1)
        self.assertEqual(primary.call_api.await_args.args[2], "primary-model")
        self.assertEqual(backup.call_api.await_args.args[2], "backup-model")
        self.assertEqual(self.manager.get_last_metrics()["provider_name"], "备用提供商")

    async def test_text_to_image_uses_each_provider_text_model(self):
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value="请求超时"),
            get_last_metrics=lambda: {},
        )
        backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"image-data"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[primary, backup]),
        ):
            await self.manager.call_api(
                [],
                "画一只猫",
                "caller-model",
                use_text_to_image_api=True,
            )

        self.assertEqual(primary.call_api.await_args.args[2], "primary-text-model")
        self.assertEqual(backup.call_api.await_args.args[2], "backup-text-model")

    async def test_active_provider_rotates_fallback_order_and_wraps(self):
        self.config["active_provider"] = "备用提供商"
        backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value="备用站错误"),
            get_last_metrics=lambda: {},
        )
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"primary-image"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[backup, primary]),
        ) as get_manager:
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"primary-image")
        self.assertEqual(backup.call_api.await_args.args[2], "backup-model")
        self.assertEqual(primary.call_api.await_args.args[2], "primary-model")
        self.assertEqual(
            [call.args[0] for call in get_manager.await_args_list],
            ["backup:1", "backup:0"],
        )
        metrics = self.manager.get_last_metrics()
        self.assertEqual(metrics["provider_name"], "主提供商")
        self.assertEqual(metrics["provider_index"], 0)
        self.assertEqual(metrics["provider_attempts"], 2)

    def test_index_selector_can_target_duplicate_provider_name(self):
        self.config["model_providers"][0]["name"] = "同名站"
        self.config["model_providers"][1]["name"] = "同名站"
        self.config["active_provider"] = "#2"

        providers = self.manager._get_enabled_providers()

        self.assertEqual(
            [provider["_provider_source_index"] for provider in providers],
            [1, 0],
        )

    def test_duplicate_name_selector_keeps_panel_order(self):
        self.config["model_providers"][0]["name"] = "同名站"
        self.config["model_providers"][1]["name"] = "同名站"
        self.config["active_provider"] = "同名站"

        providers = self.manager._get_enabled_providers()

        self.assertEqual(
            [provider["_provider_source_index"] for provider in providers],
            [0, 1],
        )

    async def test_invalid_active_provider_keeps_panel_order(self):
        self.config["active_provider"] = "已删除的提供商"
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"primary-image"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(return_value=primary),
        ):
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"primary-image")
        self.assertEqual(primary.call_api.await_args.args[2], "primary-model")
        self.assertEqual(
            self.manager.get_last_metrics()["provider_name"],
            "主提供商",
        )

    def test_auto_alias_keeps_panel_order(self):
        self.config["active_provider"] = "自动"
        providers = self.manager._get_enabled_providers()
        self.assertEqual(
            [self.manager._normalize_provider_name(item, index)
             for index, item in enumerate(providers)],
            ["主提供商", "备用提供商"],
        )

    async def test_disabled_provider_is_skipped_and_empty_bytes_fall_back(self):
        self.config["model_providers"].insert(0, {
            "name": "已停用提供商",
            "enabled": False,
            "model": "disabled-model",
        })
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b""),
            get_last_metrics=lambda: {},
        )
        backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"image-data"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[primary, backup]),
        ) as get_manager:
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"image-data")
        self.assertEqual(get_manager.await_count, 2)
        self.assertEqual(primary.call_api.await_count, 1)
        self.assertEqual(backup.call_api.await_count, 1)

    async def test_all_failures_are_summarized(self):
        primary = types.SimpleNamespace(
            call_api=AsyncMock(return_value="主站错误"),
            get_last_metrics=lambda: {},
        )
        backup = types.SimpleNamespace(
            call_api=AsyncMock(side_effect=RuntimeError("备用站断开")),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[primary, backup]),
        ):
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertIsInstance(result, str)
        self.assertIn("所有模型提供商均调用失败", result)
        self.assertIn("主提供商: 主站错误", result)
        self.assertIn("备用提供商: 系统错误: RuntimeError: 备用站断开", result)

    async def test_incomplete_provider_is_skipped_before_network_call(self):
        self.config["model_providers"].insert(0, {
            "name": "缺少配置",
            "enabled": True,
            "interface_mode": "openai_chat",
            "base_url": "",
            "api_keys": "",
            "model": "invalid-model",
        })
        backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"image-data"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(return_value=backup),
        ) as get_manager:
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"image-data")
        self.assertEqual(get_manager.await_count, 1)
        self.assertEqual(get_manager.await_args.args[0], "backup:1")
        self.assertEqual(self.manager.get_last_metrics()["provider_attempts"], 1)

    async def test_cache_fingerprint_ignores_unrelated_config_changes(self):
        provider = self.manager._get_enabled_providers()[0]
        first_config = self.manager._build_provider_config(provider)
        first_manager = await self.manager._get_provider_manager(0, first_config)

        self.config["prompt_list"] = ["新预设:不会影响网络配置"]
        second_config = self.manager._build_provider_config(provider)
        second_manager = await self.manager._get_provider_manager(0, second_config)

        self.assertIs(first_manager, second_manager)
        self.assertEqual(second_manager.config["prompt_list"], self.config["prompt_list"])

    async def test_cache_fingerprint_rebuilds_when_network_config_changes(self):
        provider = self.manager._get_enabled_providers()[0]
        first_manager = await self.manager._get_provider_manager(
            0, self.manager._build_provider_config(provider)
        )
        first_manager.close = AsyncMock()

        provider["base_url"] = "https://changed.example.com"
        second_manager = await self.manager._get_provider_manager(
            0, self.manager._build_provider_config(provider)
        )

        self.assertIsNot(first_manager, second_manager)
        first_manager.close.assert_awaited_once()

    def test_top_config_is_primary_before_backup_list(self):
        self.config.update({
            "interface_mode": "openai_image",
            "base_url": "https://top.example.com",
            "api_keys": "top-key",
            "model": "top-model",
            "text_to_image_model": "top-text-model",
        })

        providers = self.manager._get_enabled_providers()

        self.assertEqual(
            [provider["_provider_identity"] for provider in providers],
            ["primary", "backup:0", "backup:1"],
        )
        self.assertEqual(providers[0]["_provider_display_name"], "主提供商（上方配置）")
        self.assertEqual(providers[0]["model"], "top-model")

    async def test_provider_child_manager_is_leaf_and_does_not_recurse(self):
        self.config.update({
            "interface_mode": "openai_image",
            "base_url": "https://top.example.com",
            "api_keys": "top-key",
            "model": "top-model",
        })
        provider = self.manager._get_enabled_providers()[0]
        child_config = self.manager._build_provider_config(provider)
        child = await self.manager._get_provider_manager("primary", child_config)

        self.assertTrue(child.config["_provider_leaf"])
        self.assertEqual(child._get_enabled_providers(), [])

        with patch.object(
            child,
            "_call_api_once",
            AsyncMock(return_value=b"leaf-image"),
        ) as call_once:
            result = await child.call_api([], "画一只猫", "top-model")

        self.assertEqual(result, b"leaf-image")
        call_once.assert_awaited_once()

    async def test_top_config_fails_then_falls_back_to_lower_provider(self):
        self.config.update({
            "interface_mode": "openai_image",
            "base_url": "https://top.example.com",
            "api_keys": "top-key",
            "model": "top-model",
        })
        top = types.SimpleNamespace(
            call_api=AsyncMock(return_value="上方主站故障"),
            get_last_metrics=lambda: {},
        )
        first_backup = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"backup-image"),
            get_last_metrics=lambda: {},
        )

        with patch.object(
            self.manager,
            "_get_provider_manager",
            AsyncMock(side_effect=[top, first_backup]),
        ) as get_manager:
            result = await self.manager.call_api([], "画一只猫", "caller-model")

        self.assertEqual(result, b"backup-image")
        self.assertEqual(
            [call.args[0] for call in get_manager.await_args_list],
            ["primary", "backup:0"],
        )
        self.assertEqual(top.call_api.await_args.args[2], "top-model")
        self.assertEqual(first_backup.call_api.await_args.args[2], "primary-model")

    async def test_top_config_works_without_backup_list(self):
        manager = self.ApiManager({
            "interface_mode": "openai_image",
            "base_url": "https://top.example.com",
            "api_keys": "top-key",
            "model": "top-model",
            "model_providers": [],
        })
        top = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"top-image"),
            get_last_metrics=lambda: {},
        )
        try:
            with patch.object(
                manager,
                "_get_provider_manager",
                AsyncMock(return_value=top),
            ) as get_manager:
                result = await manager.call_api([], "画一只猫", "caller-model")

            self.assertEqual(result, b"top-image")
            self.assertEqual(get_manager.await_args.args[0], "primary")
            self.assertEqual(manager.get_last_metrics()["provider_name"], "主提供商（上方配置）")
        finally:
            await manager.close()

    async def test_top_text_only_config_is_valid_for_text_to_image(self):
        manager = self.ApiManager({
            "interface_mode": "openai_image",
            "base_url": "",
            "api_keys": "",
            "text_to_image_api_url": "https://text.example.com",
            "text_to_image_api_keys": ["text-key"],
            "model": "normal-model",
            "text_to_image_model": "text-model",
            "model_providers": [],
        })
        top = types.SimpleNamespace(
            call_api=AsyncMock(return_value=b"text-image"),
            get_last_metrics=lambda: {},
        )
        try:
            with patch.object(
                manager,
                "_get_provider_manager",
                AsyncMock(return_value=top),
            ) as get_manager:
                result = await manager.call_api(
                    [],
                    "画一只猫",
                    "caller-model",
                    use_text_to_image_api=True,
                )

            self.assertEqual(result, b"text-image")
            self.assertEqual(get_manager.await_args.args[0], "primary")
            self.assertEqual(top.call_api.await_args.args[2], "text-model")
        finally:
            await manager.close()

    def test_stable_identity_selector_can_select_primary_and_backup(self):
        self.config.update({
            "interface_mode": "openai_image",
            "base_url": "https://top.example.com",
            "api_keys": "top-key",
        })
        self.config["active_provider"] = "@backup:1"
        providers = self.manager._get_enabled_providers()
        self.assertEqual(
            [provider["_provider_identity"] for provider in providers],
            ["backup:1", "primary", "backup:0"],
        )

        self.config["active_provider"] = "@primary"
        providers = self.manager._get_enabled_providers()
        self.assertEqual(providers[0]["_provider_identity"], "primary")

    async def test_empty_provider_list_keeps_legacy_call_path(self):
        manager = self.ApiManager({"model_providers": []})
        try:
            with patch.object(
                manager,
                "_call_api_once",
                AsyncMock(return_value=b"legacy-image"),
            ) as call_once:
                result = await manager.call_api([], "画一只猫", "legacy-model")

            self.assertEqual(result, b"legacy-image")
            call_once.assert_awaited_once()
        finally:
            await manager.close()

    async def test_all_disabled_backups_still_report_incomplete_primary(self):
        manager = self.ApiManager({
            "model_providers": [{"name": "停用项", "enabled": False}],
            "base_url": "https://legacy.example.com",
        })
        try:
            with patch.object(
                manager,
                "_call_api_once",
                AsyncMock(return_value=b"unexpected"),
            ) as call_once:
                result = await manager.call_api([], "画一只猫", "legacy-model")

            self.assertIn("所有模型提供商均调用失败", result)
            self.assertIn("主提供商（上方配置）: 未配置 API Key", result)
            call_once.assert_not_awaited()
        finally:
            await manager.close()


class ProviderSchemaTest(unittest.TestCase):
    def test_schema_contains_provider_list_and_no_checkin_fields(self):
        import json

        schema = json.loads((ROOT / "_conf_schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["model_providers"]["type"], "template_list")
        self.assertIn("image_provider", schema["model_providers"]["templates"])
        self.assertIn("active_provider", schema)
        self.assertEqual(schema["active_provider"]["default"], "")
        for key in (
            "enable_checkin",
            "checkin_fixed_reward",
            "enable_random_checkin",
            "checkin_random_reward_max",
        ):
            self.assertNotIn(key, schema)

    def test_main_registers_provider_commands_and_persistence_key(self):
        main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn('@filter.command("提供商列表"', main_source)
        self.assertIn('@filter.command("切换提供商"', main_source)
        self.assertIn('"active_provider",', main_source)
        self.assertIn("_iter_configured_providers()", main_source)
        self.assertIn('selector = f"@{identity}"', main_source)
        self.assertIn('self._save_config(["active_provider"])', main_source)
        api_source = (ROOT / "api_manager.py").read_text(encoding="utf-8")
        self.assertIn('provider_config["_provider_leaf"] = True', api_source)
        self.assertIn('self.config.get("_provider_leaf", False)', api_source)
        self.assertIn('"2.12.2"', main_source)
        self.assertIn("version: v2.12.2", (ROOT / "metadata.yaml").read_text(encoding="utf-8"))
        command_priority_block = main_source.split(
            "_COMMAND_PRIORITY_DYNAMIC_KEYS = {", 1
        )[1].split("}", 1)[0]
        self.assertIn('"active_provider"', command_priority_block)


if __name__ == "__main__":
    unittest.main()
