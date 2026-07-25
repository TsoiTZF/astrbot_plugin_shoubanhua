## v2.9.0
- 新增 OpenAI Images、OpenAI Chat、Gemini 官方、自定义完整路径四种接口模式
- 自动识别提示词中的常规宽高比与 1K/2K/4K，并填充 OpenAI `size` 或 Gemini `imageConfig`
- 文生图默认比例可配置为 4:3，图生图会自动识别原图比例
- 补充 aiohttp、Pillow、PyMuPDF 插件依赖声明

## v2.8.8
- 优化上下文逻辑修改配置文件写入逻辑
