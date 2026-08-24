"""手办工坊 Pro - AstrBot 插件独立 WebUI 后端接口。

符合 AstrBot Plugin Pages 规范，路由前缀为 `/{PLUGIN_NAME}/page/...`。
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional

from astrbot.api import logger
from astrbot.api.web import error_response, file_response, json_response, request

PLUGIN_NAME = "astrbot_plugin_shoubanhua"


class ShoubanhuaWebUI:
    """手办工坊 WebUI 后端控制器。"""

    def __init__(self, plugin: Any) -> None:
        self.plugin = plugin
        self.data_mgr = plugin.data_mgr
        self.api_mgr = plugin.api_mgr
        self.img_mgr = plugin.img_mgr
        self.base_dir = Path(__file__).resolve().parent
        self.pages_dir = self.base_dir / "pages" / "dashboard"

    def register(self, context: Any) -> None:
        """注册所有 Web API 路由到 AstrBot 上下文。"""
        if not hasattr(context, "register_web_api"):
            logger.warning("FigurinePro: 当前 AstrBot 版本不支持 register_web_api，跳过 WebUI 路由注册。")
            return

        routes = [
            # 基础启动数据
            ("bootstrap", self.handle_bootstrap, ["GET"], "获取 WebUI 初始化数据"),
            # 预设提示词 CRUD
            ("prompts", self.handle_get_prompts, ["GET"], "获取所有预设提示词列表"),
            ("prompts/save", self.handle_save_prompt, ["POST"], "添加或修改预设提示词"),
            ("prompts/delete", self.handle_delete_prompt, ["POST"], "删除预设提示词"),
            ("prompts/import", self.handle_import_prompts, ["POST"], "批量导入预设提示词"),
            ("prompts/export", self.handle_export_prompts, ["GET"], "导出预设提示词文本"),
            # 预设参考图
            ("ref-images", self.handle_get_ref_images, ["GET"], "获取指定预设的参考图列表"),
            ("ref-images/upload", self.handle_upload_ref_image, ["POST"], "为预设上传参考图"),
            ("ref-images/delete", self.handle_delete_ref_image, ["POST"], "删除指定预设的单张参考图"),
            ("ref-images/clear", self.handle_clear_ref_images, ["POST"], "清空指定预设的全部参考图"),
            # 人设管理
            ("persona", self.handle_get_persona, ["GET"], "获取人设信息及场景列表"),
            ("persona/save", self.handle_save_persona, ["POST"], "修改人设与场景提示词"),
            # 在线测试出图
            ("test-generate", self.handle_test_generate, ["POST"], "在线测试生图"),
        ]

        for route, handler, methods, desc in routes:
            context.register_web_api(
                f"/{PLUGIN_NAME}/page/{route}",
                handler,
                methods,
                f"手办工坊 Pro: {desc}",
            )
        logger.info("FigurinePro: 手办工坊 WebUI 页面路由注册完成。")

    # ── 辅助方法 ───────────────────────────────────────────────

    async def _read_json(self) -> Dict[str, Any]:
        """读取请求 JSON 体。"""
        try:
            body = await request.json()
            if isinstance(body, dict):
                return body
        except Exception:
            pass
        return {}

    # ── 接口实现 ───────────────────────────────────────────────

    async def handle_bootstrap(self) -> Any:
        """返回 WebUI 启动所需的全局配置与概览数据。"""
        prompts = self._collect_all_prompts()
        providers = []
        if hasattr(self.api_mgr, "_iter_configured_providers"):
            for idx, p in enumerate(self.api_mgr._iter_configured_providers()):
                name = self.api_mgr._normalize_provider_name(p, idx)
                providers.append({
                    "index": idx + 1,
                    "name": name,
                    "model": p.get("model", ""),
                    "interface_mode": p.get("interface_mode", ""),
                    "enabled": p.get("enabled", True) is not False,
                })

        return json_response({
            "status": "ok",
            "data": {
                "version": getattr(self.plugin, "version", "2.12.2"),
                "total_prompts": len(prompts),
                "custom_prompts_count": len(self.data_mgr.user_prompts),
                "active_model": self.plugin.conf.get("model", "nano-banana"),
                "image_resolution": self.plugin.conf.get("image_resolution", "1K"),
                "image_aspect_ratio": self.plugin.conf.get("image_aspect_ratio", "4:3"),
                "interface_mode": self.plugin.conf.get("interface_mode", "openai_image"),
                "enable_persona_mode": self.plugin.conf.get("enable_persona_mode", False),
                "providers": providers,
            }
        })

    def _collect_all_prompts(self) -> List[Dict[str, Any]]:
        """整理内置预设与自定义预设列表。"""
        self.data_mgr.reload_prompts()
        result = []
        user_keys = set(self.data_mgr.user_prompts.keys())

        for key, prompt in self.data_mgr.prompt_map.items():
            is_custom = key in user_keys
            ref_paths = self.data_mgr.get_preset_ref_image_paths(key)
            has_sample = bool(self.data_mgr.get_preset_image_path(key))
            result.append({
                "key": key,
                "prompt": prompt,
                "is_custom": is_custom,
                "ref_image_count": len(ref_paths),
                "has_sample_image": has_sample,
            })
        result.sort(key=lambda x: (not x["is_custom"], x["key"]))
        return result

    async def handle_get_prompts(self) -> Any:
        """获取所有预设提示词。"""
        return json_response({
            "status": "ok",
            "data": self._collect_all_prompts()
        })

    async def handle_save_prompt(self) -> Any:
        """新增或更新自定义预设。"""
        body = await self._read_json()
        key = str(body.get("key") or "").strip()
        prompt = str(body.get("prompt") or "").strip()

        if not key:
            return error_response("预设触发词（关键词）不能为空。")
        if not prompt:
            return error_response("提示词内容不能为空。")

        await self.data_mgr.add_user_prompt(key, prompt)
        logger.info(f"FigurinePro WebUI: 已保存预设 [{key}]")
        return json_response({
            "status": "ok",
            "message": f"预设 [{key}] 保存成功。"
        })

    async def handle_delete_prompt(self) -> Any:
        """删除自定义预设并清理绑定的参考图。"""
        body = await self._read_json()
        key = str(body.get("key") or "").strip()

        if not key:
            return error_response("请指定要删除的预设名称。")

        if key not in self.data_mgr.user_prompts:
            return error_response(f"[{key}] 为内置预设，无法直接删除。")

        await self.data_mgr.remove_user_prompt(key)
        await self.data_mgr.clear_preset_ref_images(key)

        logger.info(f"FigurinePro WebUI: 已删除预设 [{key}]")
        return json_response({
            "status": "ok",
            "message": f"预设 [{key}] 已成功删除。"
        })

    async def handle_import_prompts(self) -> Any:
        """批量导入预设。"""
        body = await self._read_json()
        raw_text = str(body.get("text") or "").strip()
        overwrite = bool(body.get("overwrite", True))

        if not raw_text:
            return error_response("导入内容不能为空。")

        imported_count = 0
        skipped_count = 0

        try:
            json_obj = json.loads(raw_text)
            if isinstance(json_obj, dict):
                for k, v in json_obj.items():
                    key_str = str(k).strip()
                    val_str = str(v).strip()
                    if key_str and val_str:
                        if not overwrite and key_str in self.data_mgr.user_prompts:
                            skipped_count += 1
                            continue
                        await self.data_mgr.add_user_prompt(key_str, val_str)
                        imported_count += 1
                return json_response({
                    "status": "ok",
                    "message": f"批量导入完成：成功 {imported_count} 条，跳过 {skipped_count} 条。"
                })
        except Exception:
            pass

        for line in raw_text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            splitter = ":" if ":" in line else ("：" if "：" in line else None)
            if not splitter:
                continue
            parts = line.split(splitter, 1)
            if len(parts) == 2:
                key_str = parts[0].strip()
                val_str = parts[1].strip()
                if key_str and val_str:
                    if not overwrite and key_str in self.data_mgr.user_prompts:
                        skipped_count += 1
                        continue
                    await self.data_mgr.add_user_prompt(key_str, val_str)
                    imported_count += 1

        logger.info(f"FigurinePro WebUI: 批量导入完成 成功={imported_count}, 跳过={skipped_count}")
        return json_response({
            "status": "ok",
            "message": f"批量导入完成：成功导入 {imported_count} 个预设，跳过 {skipped_count} 个。"
        })

    async def handle_export_prompts(self) -> Any:
        """导出所有自定义预设。"""
        self.data_mgr.reload_prompts()
        lines = []
        for k, v in sorted(self.data_mgr.user_prompts.items()):
            lines.append(f"{k}:{v}")
        return json_response({
            "status": "ok",
            "data": {
                "text": "\n".join(lines),
                "json": self.data_mgr.user_prompts,
                "count": len(self.data_mgr.user_prompts)
            }
        })

    async def handle_get_ref_images(self) -> Any:
        """获取指定预设或人设的参考图。"""
        preset_name = str(request.args.get("preset_name") or "").strip()
        if not preset_name:
            return error_response("请提供 preset_name 参数。")

        image_paths = self.data_mgr.get_preset_ref_image_paths(preset_name)
        images_data = []

        for idx, p in enumerate(image_paths):
            try:
                raw = p.read_bytes()
                mime = self.api_mgr.get_mime_type(raw)
                b64 = base64.b64encode(raw).decode()
                images_data.append({
                    "index": idx,
                    "filename": p.name,
                    "size_kb": round(len(raw) / 1024, 1),
                    "data_url": f"data:{mime};base64,{b64}",
                })
            except Exception as e:
                logger.warning(f"读取参考图失败 {p}: {e}")

        return json_response({
            "status": "ok",
            "data": {
                "preset_name": preset_name,
                "total": len(images_data),
                "images": images_data
            }
        })

    async def handle_upload_ref_image(self) -> Any:
        """上传参考图。"""
        body = await self._read_json()
        preset_name = str(body.get("preset_name") or "").strip()
        images_b64 = body.get("images", [])

        if not preset_name:
            return error_response("请指定 preset_name。")
        if not images_b64 or not isinstance(images_b64, list):
            return error_response("请提供 Base64 图片列表。")

        images_bytes = []
        for item in images_b64:
            try:
                b64_str = str(item)
                if "base64," in b64_str:
                    b64_str = b64_str.split("base64,")[-1]
                images_bytes.append(base64.b64decode(b64_str))
            except Exception as e:
                return error_response(f"Base64 图片解码失败: {e}")

        if not images_bytes:
            return error_response("未解析出有效图片数据。")

        added_count = await self.data_mgr.add_preset_ref_images(preset_name, images_bytes)
        logger.info(f"FigurinePro WebUI: 已为预设 [{preset_name}] 添加 {added_count} 张参考图")
        return json_response({
            "status": "ok",
            "message": f"成功为 [{preset_name}] 添加 {added_count} 张参考图。"
        })

    async def handle_delete_ref_image(self) -> Any:
        """删除指定预设的单张参考图。"""
        body = await self._read_json()
        preset_name = str(body.get("preset_name") or "").strip()
        index = body.get("index")

        if not preset_name or index is None:
            return error_response("请提供 preset_name 和 index。")

        try:
            index_int = int(index)
        except Exception:
            return error_response("index 必须为整数。")

        success = await self.data_mgr.delete_preset_ref_image(preset_name, index_int)
        if success:
            return json_response({"status": "ok", "message": f"参考图 #{index_int + 1} 已删除。"})
        else:
            return error_response(f"删除失败，未找到序号 #{index_int + 1} 的参考图。")

    async def handle_clear_ref_images(self) -> Any:
        """清空指定预设的全部参考图。"""
        body = await self._read_json()
        preset_name = str(body.get("preset_name") or "").strip()

        if not preset_name:
            return error_response("请提供 preset_name。")

        count = await self.data_mgr.clear_preset_ref_images(preset_name)
        return json_response({
            "status": "ok",
            "message": f"已清空 [{preset_name}] 的全部参考图（共 {count} 张）。"
        })

    async def handle_get_persona(self) -> Any:
        """获取人设配置与人设场景列表。"""
        conf = self.plugin.conf
        persona_scenes = conf.get("persona_scene_prompts", [])
        scenes = []
        if isinstance(persona_scenes, list):
            for item in persona_scenes:
                if ":" in item:
                    k, v = item.split(":", 1)
                    scenes.append({"name": k.strip(), "prompt": v.strip()})

        persona_ref_count = len(self.data_mgr.get_preset_ref_image_paths("_persona_"))

        return json_response({
            "status": "ok",
            "data": {
                "enabled": conf.get("enable_persona_mode", False),
                "name": conf.get("persona_name", "小助手"),
                "description": conf.get("persona_description", "一个可爱的二次元女孩"),
                "photo_style": conf.get("persona_photo_style", "日常生活风格，自然光线，真实感"),
                "default_prompt": conf.get("persona_default_prompt", "一张日常生活照片，自然的姿态和表情"),
                "trigger_keywords": conf.get("persona_trigger_keywords", ["拍照", "自拍", "看看你"]),
                "scenes": scenes,
                "persona_ref_count": persona_ref_count,
            }
        })

    async def handle_save_persona(self) -> Any:
        """更新人设信息与场景。"""
        body = await self._read_json()
        conf = self.plugin.conf

        if "name" in body:
            conf["persona_name"] = str(body["name"]).strip()
        if "description" in body:
            conf["persona_description"] = str(body["description"]).strip()
        if "photo_style" in body:
            conf["persona_photo_style"] = str(body["photo_style"]).strip()
        if "default_prompt" in body:
            conf["persona_default_prompt"] = str(body["default_prompt"]).strip()
        if "enabled" in body:
            conf["enable_persona_mode"] = bool(body["enabled"])
        if "scenes" in body and isinstance(body["scenes"], list):
            scene_lines = []
            for s in body["scenes"]:
                name = str(s.get("name", "")).strip()
                prompt = str(s.get("prompt", "")).strip()
                if name and prompt:
                    scene_lines.append(f"{name}:{prompt}")
            conf["persona_scene_prompts"] = scene_lines

        self.plugin._save_config([
            "persona_name", "persona_description", "persona_photo_style",
            "persona_default_prompt", "enable_persona_mode", "persona_scene_prompts"
        ])
        self.plugin._load_persona_scenes()
        logger.info("FigurinePro WebUI: 人设配置已更新。")
        return json_response({"status": "ok", "message": "人设配置保存成功。"})

    async def handle_test_generate(self) -> Any:
        """在线测试生图。"""
        body = await self._read_json()
        prompt = str(body.get("prompt") or "").strip()
        input_image_b64 = str(body.get("input_image") or "").strip()
        model_override = str(body.get("model") or "").strip()
        aspect_ratio = str(body.get("aspect_ratio") or "4:3").strip()
        resolution = str(body.get("resolution") or "1K").strip()

        if not prompt:
            return error_response("提示词不能为空。")

        images = []
        if input_image_b64:
            try:
                if "base64," in input_image_b64:
                    input_image_b64 = input_image_b64.split("base64,")[-1]
                images.append(base64.b64decode(input_image_b64))
            except Exception as e:
                return error_response(f"输入图片解析失败: {e}")

        model = model_override or self.plugin.conf.get("model", "nano-banana")
        is_text_to_image = not images

        try:
            res = await self.api_mgr.call_api(
                images=images,
                prompt=prompt,
                model=model,
                proxy=self.img_mgr.proxy,
                use_text_to_image_api=is_text_to_image,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
            )

            if isinstance(res, bytes):
                mime = self.api_mgr.get_mime_type(res)
                b64 = base64.b64encode(res).decode()
                metrics = self.api_mgr.get_last_metrics() if hasattr(self.api_mgr, "get_last_metrics") else {}
                return json_response({
                    "status": "ok",
                    "data": {
                        "image_url": f"data:{mime};base64,{b64}",
                        "model": metrics.get("model", model),
                        "provider": metrics.get("provider_name", "主提供商"),
                        "duration": f"{metrics.get('total_duration', 0):.2f}s",
                    }
                })
            else:
                return error_response(f"生成失败: {res}")
        except Exception as e:
            logger.error(f"FigurinePro WebUI: 测试出图异常 {e}")
            return error_response(f"出图异常: {e}")
