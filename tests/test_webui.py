"""手办工坊 WebUI 接口测试。"""

import importlib
import pathlib
import sys
import types
import unittest
from unittest.mock import MagicMock, AsyncMock

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "shoubanhua_webui_test_package"


def load_webui():
    if PACKAGE not in sys.modules:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package

    if "astrbot" not in sys.modules or not hasattr(sys.modules["astrbot"], "__path__"):
        astrbot = types.ModuleType("astrbot")
        astrbot.__path__ = []
        astrbot.logger = types.SimpleNamespace(
            info=lambda *args, **kwargs: None,
            warning=lambda *args, **kwargs: None,
            error=lambda *args, **kwargs: None,
        )
        sys.modules["astrbot"] = astrbot

    if "astrbot.api" not in sys.modules or not hasattr(sys.modules["astrbot.api"], "__path__"):
        api = types.ModuleType("astrbot.api")
        api.__path__ = []
        api.logger = sys.modules["astrbot"].logger
        sys.modules["astrbot.api"] = api
        setattr(sys.modules["astrbot"], "api", api)

    if "astrbot.api.web" not in sys.modules:
        web = types.ModuleType("astrbot.api.web")
        web.json_response = lambda data, status_code=200, headers=None: {"status_code": status_code, **data}
        web.error_response = lambda msg, status_code=400, data=None, headers=None: {"status": "error", "message": msg}
        web.file_response = lambda path, filename=None, content_type=None, headers=None: {"path": str(path)}
        web.request = types.SimpleNamespace(json=AsyncMock(return_value={}), args={})
        sys.modules["astrbot.api.web"] = web
        setattr(sys.modules["astrbot.api"], "web", web)

    return importlib.import_module(f"{PACKAGE}.webui").ShoubanhuaWebUI


class DummyDataManager:
    def __init__(self):
        self.user_prompts = {"测试手办": "masterpiece, 1girl figure"}
        self.prompt_map = {"手办化": "[内置预设]", "测试手办": "masterpiece, 1girl figure"}
        self.ref_images = {"测试手办": [pathlib.Path("img1.png")]}

    def reload_prompts(self):
        pass

    def get_preset_ref_image_paths(self, key):
        return self.ref_images.get(key, [])

    def get_preset_image_path(self, key):
        return None

    async def add_user_prompt(self, key, prompt):
        self.user_prompts[key] = prompt
        self.prompt_map[key] = prompt

    async def remove_user_prompt(self, key):
        if key in self.user_prompts:
            del self.user_prompts[key]
            del self.prompt_map[key]
            return True
        return False

    async def clear_preset_ref_images(self, key):
        self.ref_images.pop(key, None)
        return 1

    async def add_preset_ref_images(self, key, images):
        return len(images)

    async def delete_preset_ref_image(self, key, index):
        return True


class DummyPlugin:
    def __init__(self):
        self.base_dir = str(ROOT)
        self.conf = {
            "model": "gpt-image-2",
            "image_resolution": "4K",
            "image_aspect_ratio": "4:3",
            "interface_mode": "openai_image",
            "enable_persona_mode": True,
            "persona_name": "小助手",
            "persona_description": "可爱的二次元女孩",
            "persona_photo_style": "日常写实",
            "persona_default_prompt": "日常自拍",
            "persona_trigger_keywords": ["自拍", "拍照"],
            "persona_scene_prompts": ["咖啡店:在咖啡馆喝咖啡"],
        }
        self.data_mgr = DummyDataManager()
        self.api_mgr = MagicMock()
        self.api_mgr._iter_configured_providers = MagicMock(return_value=[])
        self.api_mgr.get_mime_type = MagicMock(return_value="image/png")
        self.img_mgr = MagicMock()
        self.img_mgr.proxy = None
        self._load_persona_scenes = MagicMock()
        self._save_config = MagicMock()


class WebUITest(unittest.IsolatedAsyncioTestCase):
    async def test_collect_prompts(self):
        ShoubanhuaWebUI = load_webui()
        plugin = DummyPlugin()
        ui = ShoubanhuaWebUI(plugin)
        prompts = ui._collect_all_prompts()
        self.assertEqual(len(prompts), 2)
        keys = [p["key"] for p in prompts]
        self.assertIn("手办化", keys)
        self.assertIn("测试手办", keys)

    async def test_add_and_delete_prompt(self):
        ShoubanhuaWebUI = load_webui()
        plugin = DummyPlugin()
        ui = ShoubanhuaWebUI(plugin)

        # 模拟新增
        ui._read_json = AsyncMock(return_value={"key": "赛博风", "prompt": "cyberpunk city, neon lights"})
        await ui.handle_save_prompt()
        self.assertEqual(plugin.data_mgr.user_prompts["赛博风"], "cyberpunk city, neon lights")

        # 模拟删除
        ui._read_json = AsyncMock(return_value={"key": "赛博风"})
        await ui.handle_delete_prompt()
        self.assertNotIn("赛博风", plugin.data_mgr.user_prompts)

    async def test_register_routes(self):
        ShoubanhuaWebUI = load_webui()
        plugin = DummyPlugin()
        ui = ShoubanhuaWebUI(plugin)
        ctx = MagicMock()
        ctx.register_web_api = MagicMock()
        ui.register(ctx)
        self.assertTrue(ctx.register_web_api.called)
        # 验证至少注册了 prompts 路由
        calls = [c[0][0] for c in ctx.register_web_api.call_args_list]
        self.assertIn("/astrbot_plugin_shoubanhua/page/prompts", calls)
        self.assertIn("/astrbot_plugin_shoubanhua/page/bootstrap", calls)
