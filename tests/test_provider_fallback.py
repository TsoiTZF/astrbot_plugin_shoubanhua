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
            [1, 0],
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
        self.assertEqual(get_manager.await_args.args[0], 1)
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

    async def test_all_disabled_providers_do_not_use_legacy_endpoint(self):
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

            self.assertEqual(result, "模型提供商列表中没有已启用的有效配置")
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
        self.assertIn('selector = f"#{index + 1}"', main_source)
        self.assertIn('self._save_config(["active_provider"])', main_source)
        self.assertIn('"2.12.0"', main_source)
        self.assertIn("version: v2.12.0", (ROOT / "metadata.yaml").read_text(encoding="utf-8"))
        command_priority_block = main_source.split(
            "_COMMAND_PRIORITY_DYNAMIC_KEYS = {", 1
        )[1].split("}", 1)[0]
        self.assertIn('"active_provider"', command_priority_block)


if __name__ == "__main__":
    unittest.main()
