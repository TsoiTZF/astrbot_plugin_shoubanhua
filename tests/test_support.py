import sys
import types


def install_api_manager_stubs():
    """为纯编排单元测试提供最小依赖桩，不执行真实网络请求。"""
    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")

        class Placeholder:
            def __init__(self, *args, **kwargs):
                pass

        aiohttp.ClientSession = Placeholder
        aiohttp.ClientTimeout = Placeholder
        aiohttp.FormData = Placeholder
        aiohttp.TCPConnector = Placeholder
        sys.modules["aiohttp"] = aiohttp

    if "astrbot" not in sys.modules:
        astrbot = types.ModuleType("astrbot")
        astrbot.logger = types.SimpleNamespace(
            info=lambda *args, **kwargs: None,
            warning=lambda *args, **kwargs: None,
            error=lambda *args, **kwargs: None,
        )
        sys.modules["astrbot"] = astrbot
