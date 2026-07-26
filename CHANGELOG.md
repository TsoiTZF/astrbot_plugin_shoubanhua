## v2.9.0
- 修复 `#切换模型` 在管理员 ID 类型不一致或旧模型列表格式异常时无响应的问题
- 统一 URL 自动补全：基础地址中的 v1/v1beta 和完整接口尾部会被忽略，再按所选模式生成唯一请求地址
- 新增 OpenAI Images、OpenAI Chat、Gemini 官方、自定义完整路径四种接口模式
- 配置面板移除旧 Generic/Gemini 独立地址、Key 池和 api_mode，仅保留统一接口配置；旧配置仍可静默读取
- `#切换API模式 generic` 等旧指令写法继续兼容，并映射到新的接口模式
- 自动识别提示词中的常规宽高比与 1K/2K/4K，并填充 OpenAI `size` 或 Gemini `imageConfig`
- 文生图默认比例可配置为 4:3，图生图会自动识别原图比例
- 补充 aiohttp、Pillow、PyMuPDF 插件依赖声明

## v2.8.8
- 优化上下文逻辑修改配置文件写入逻辑
