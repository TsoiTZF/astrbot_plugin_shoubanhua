const { createApp, ref, reactive, computed, onMounted } = Vue;

class BridgeClient {
    constructor() {
        this.bridge = window.AstrBotPluginPage || null;
    }

    async ready() {
        if (this.bridge && typeof this.bridge.ready === 'function') {
            try {
                return await this.bridge.ready();
            } catch (e) {}
        }
        return {};
    }

    async get(endpoint, params = {}) {
        if (this.bridge && typeof this.bridge.apiGet === 'function') {
            return await this.bridge.apiGet(`page/${endpoint}`, params);
        }
        // 回退到标准 fetch（开发/直接访问）
        const qs = new URLSearchParams(params).toString();
        const url = `/astrbot_plugin_shoubanhua/page/${endpoint}${qs ? '?' + qs : ''}`;
        const res = await fetch(url);
        return await res.json();
    }

    async post(endpoint, body = {}) {
        if (this.bridge && typeof this.bridge.apiPost === 'function') {
            return await this.bridge.apiPost(`page/${endpoint}`, body);
        }
        // 回退到标准 fetch
        const res = await fetch(`/astrbot_plugin_shoubanhua/page/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return await res.json();
    }
}

const client = new BridgeClient();

createApp({
    setup() {
        const currentTab = ref('prompts'); // prompts | persona | tester | settings
        const loading = ref(false);
        const toast = reactive({ show: false, message: '', type: 'success', timer: null });

        const stats = reactive({
            version: '2.12.2',
            total_prompts: 0,
            custom_prompts_count: 0,
            active_model: 'nano-banana',
            image_resolution: '1K',
            image_aspect_ratio: '4:3',
            interface_mode: 'openai_image',
            enable_persona_mode: false,
            providers: [],
        });

        const prompts = ref([]);
        const searchQuery = ref('');
        const filterType = ref('all'); // all | custom | builtin

        // 编辑预设
        const editModal = reactive({
            show: false,
            isNew: true,
            key: '',
            originalKey: '',
            prompt: '',
            saving: false,
        });

        // 导入导出
        const ioModal = reactive({
            show: false,
            mode: 'import',
            text: '',
            overwrite: true,
            loading: false,
        });

        // 参考图管理
        const refModal = reactive({
            show: false,
            presetName: '',
            images: [],
            loading: false,
            uploading: false,
        });

        // 人设配置
        const personaForm = reactive({
            enabled: false,
            name: '',
            description: '',
            photo_style: '',
            default_prompt: '',
            trigger_keywords: [],
            scenes: [],
            persona_ref_count: 0,
            saving: false,
        });

        // 在线测试
        const tester = reactive({
            prompt: '',
            inputImage: '',
            model: '',
            aspectRatio: '4:3',
            resolution: '1K',
            loading: false,
            resultImage: null,
            resultMeta: null,
        });

        const showToast = (message, type = 'success') => {
            if (toast.timer) clearTimeout(toast.timer);
            toast.message = message;
            toast.type = type;
            toast.show = true;
            toast.timer = setTimeout(() => {
                toast.show = false;
            }, 3000);
        };

        const handleApiRes = (res) => {
            if (!res || res.status === 'error') {
                const msg = res?.message || '请求处理失败';
                showToast(msg, 'error');
                throw new Error(msg);
            }
            return res;
        };

        const fetchBootstrap = async () => {
            try {
                const res = handleApiRes(await client.get('bootstrap'));
                Object.assign(stats, res.data);
                tester.model = stats.active_model;
                tester.resolution = stats.image_resolution;
                tester.aspectRatio = stats.image_aspect_ratio;
            } catch (e) {}
        };

        const fetchPrompts = async () => {
            loading.value = true;
            try {
                const res = handleApiRes(await client.get('prompts'));
                prompts.value = res.data || [];
                stats.total_prompts = prompts.value.length;
                stats.custom_prompts_count = prompts.value.filter(p => p.is_custom).length;
            } finally {
                loading.value = false;
            }
        };

        const fetchPersona = async () => {
            try {
                const res = handleApiRes(await client.get('persona'));
                Object.assign(personaForm, res.data);
            } catch (e) {}
        };

        const filteredPrompts = computed(() => {
            return prompts.value.filter(p => {
                const matchQuery = !searchQuery.value || 
                    p.key.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
                    p.prompt.toLowerCase().includes(searchQuery.value.toLowerCase());
                
                if (!matchQuery) return false;
                if (filterType.value === 'custom') return p.is_custom;
                if (filterType.value === 'builtin') return !p.is_custom;
                return true;
            });
        });

        const openCreateModal = () => {
            editModal.isNew = true;
            editModal.key = '';
            editModal.originalKey = '';
            editModal.prompt = '';
            editModal.show = true;
        };

        const openEditModal = (item) => {
            editModal.isNew = false;
            editModal.key = item.key;
            editModal.originalKey = item.key;
            editModal.prompt = item.prompt === '[内置预设]' ? '' : item.prompt;
            editModal.show = true;
        };

        const savePrompt = async () => {
            if (!editModal.key.trim()) return showToast('请输入触发词', 'error');
            if (!editModal.prompt.trim()) return showToast('请输入提示词内容', 'error');

            editModal.saving = true;
            try {
                await client.post('prompts/save', { key: editModal.key, prompt: editModal.prompt });
                showToast(`预设 [${editModal.key}] 保存成功`);
                editModal.show = false;
                await fetchPrompts();
            } finally {
                editModal.saving = false;
            }
        };

        const deletePrompt = async (item) => {
            if (!confirm(`确定删除自定义预设 [${item.key}] 吗？`)) return;
            try {
                await client.post('prompts/delete', { key: item.key });
                showToast(`预设 [${item.key}] 已删除`);
                await fetchPrompts();
            } catch (e) {}
        };

        const copyPrompt = (item) => {
            navigator.clipboard.writeText(item.prompt);
            showToast(`已复制 [${item.key}] 提示词到剪贴板`);
        };

        const openImportModal = () => {
            ioModal.mode = 'import';
            ioModal.text = '';
            ioModal.show = true;
        };

        const openExportModal = async () => {
            ioModal.mode = 'export';
            ioModal.loading = true;
            ioModal.show = true;
            try {
                const res = handleApiRes(await client.get('prompts/export'));
                ioModal.text = res.data.text;
            } finally {
                ioModal.loading = false;
            }
        };

        const executeImport = async () => {
            if (!ioModal.text.trim()) return showToast('请输入要导入的预设文本', 'error');
            ioModal.loading = true;
            try {
                const res = handleApiRes(await client.post('prompts/import', {
                    text: ioModal.text,
                    overwrite: ioModal.overwrite,
                }));
                showToast(res.message || '导入完成');
                ioModal.show = false;
                await fetchPrompts();
            } finally {
                ioModal.loading = false;
            }
        };

        const openRefModal = async (presetName) => {
            refModal.presetName = presetName;
            refModal.show = true;
            refModal.loading = true;
            try {
                const res = handleApiRes(await client.get('ref-images', { preset_name: presetName }));
                refModal.images = res.data.images || [];
            } finally {
                refModal.loading = false;
            }
        };

        const handleFileUpload = (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;

            const readers = files.map(file => {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(file);
                });
            });

            Promise.all(readers).then(async (base64List) => {
                refModal.uploading = true;
                try {
                    await client.post('ref-images/upload', {
                        preset_name: refModal.presetName,
                        images: base64List,
                    });
                    showToast('参考图上传成功');
                    await openRefModal(refModal.presetName);
                    await fetchPrompts();
                } finally {
                    refModal.uploading = false;
                    e.target.value = '';
                }
            });
        };

        const deleteRefImage = async (index) => {
            if (!confirm(`确定删除这张参考图吗？`)) return;
            try {
                await client.post('ref-images/delete', {
                    preset_name: refModal.presetName,
                    index,
                });
                showToast('参考图已删除');
                await openRefModal(refModal.presetName);
                await fetchPrompts();
            } catch (e) {}
        };

        const clearAllRefImages = async () => {
            if (!confirm(`确定清空 [${refModal.presetName}] 的全部参考图吗？`)) return;
            try {
                await client.post('ref-images/clear', {
                    preset_name: refModal.presetName,
                });
                showToast('全部参考图已清空');
                refModal.images = [];
                await fetchPrompts();
            } catch (e) {}
        };

        const addScene = () => {
            personaForm.scenes.push({ name: '', prompt: '' });
        };

        const removeScene = (idx) => {
            personaForm.scenes.splice(idx, 1);
        };

        const savePersona = async () => {
            personaForm.saving = true;
            try {
                await client.post('persona/save', personaForm);
                showToast('人设与场景配置已保存');
            } finally {
                personaForm.saving = false;
            }
        };

        const handleTesterImageUpload = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                tester.inputImage = reader.result;
            };
            reader.readAsDataURL(file);
        };

        const runTestGenerate = async () => {
            if (!tester.prompt.trim()) return showToast('请输入测试提示词', 'error');
            tester.loading = true;
            tester.resultImage = null;
            tester.resultMeta = null;
            try {
                const res = handleApiRes(await client.post('test-generate', {
                    prompt: tester.prompt,
                    input_image: tester.inputImage,
                    model: tester.model,
                    aspect_ratio: tester.aspectRatio,
                    resolution: tester.resolution,
                }));
                tester.resultImage = res.data.image_url;
                tester.resultMeta = res.data;
                showToast('生成成功');
            } finally {
                tester.loading = false;
            }
        };

        const applyPresetToTester = (item) => {
            tester.prompt = item.prompt === '[内置预设]' ? item.key : item.prompt;
            currentTab.value = 'tester';
            showToast(`已将预设 [${item.key}] 载入测试工作台`);
        };

        onMounted(async () => {
            await client.ready();
            await fetchBootstrap();
            await fetchPrompts();
            await fetchPersona();
        });

        return {
            currentTab,
            loading,
            toast,
            stats,
            prompts,
            searchQuery,
            filterType,
            filteredPrompts,
            editModal,
            ioModal,
            refModal,
            personaForm,
            tester,
            openCreateModal,
            openEditModal,
            savePrompt,
            deletePrompt,
            copyPrompt,
            openImportModal,
            openExportModal,
            executeImport,
            openRefModal,
            handleFileUpload,
            deleteRefImage,
            clearAllRefImages,
            addScene,
            removeScene,
            savePersona,
            handleTesterImageUpload,
            runTestGenerate,
            applyPresetToTester,
        };
    },
    template: `
    <div class="layout">
        <!-- 侧边导航栏 -->
        <aside class="sidebar">
            <div class="brand">
                <div class="brand-icon">🎨</div>
                <div>
                    <div class="brand-title">手办工坊 Pro</div>
                    <div style="font-size: 11px; color: var(--text-muted);">提示词与人设中心</div>
                </div>
                <span class="brand-badge">v{{ stats.version }}</span>
            </div>
            <nav class="nav">
                <div class="nav-item" :class="{ active: currentTab === 'prompts' }" @click="currentTab = 'prompts'">
                    <span class="icon">📋</span> 预设提示词管理
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'persona' }" @click="currentTab = 'persona'">
                    <span class="icon">👤</span> 人设与日常拍照
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'tester' }" @click="currentTab = 'tester'">
                    <span class="icon">⚡</span> 在线生图测试
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'settings' }" @click="currentTab = 'settings'">
                    <span class="icon">⚙️</span> 接口与模型概览
                </div>
            </nav>
            <div style="padding: 16px; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border-color);">
                AstrBot 官方插件面板
            </div>
        </aside>

        <!-- 主内容区 -->
        <main class="main-content">
            <!-- 预设管理页面 -->
            <div v-if="currentTab === 'prompts'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>预设提示词管理</h1>
                        <p>统一管理手办化、Q版化及自定义触发词。支持参考图与批量导入导出。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-secondary" @click="openExportModal">
                            <span>📤</span> 导出
                        </button>
                        <button class="btn btn-secondary" @click="openImportModal">
                            <span>📥</span> 批量导入
                        </button>
                        <button class="btn btn-primary" @click="openCreateModal">
                            <span>➕</span> 新增预设
                        </button>
                    </div>
                </div>

                <!-- 统计卡片 -->
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-icon blue">📚</div>
                        <div>
                            <div class="stat-value">{{ stats.total_prompts }}</div>
                            <div class="stat-label">总预设数量</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon purple">✨</div>
                        <div>
                            <div class="stat-value">{{ stats.custom_prompts_count }}</div>
                            <div class="stat-label">自定义预设</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon green">🎯</div>
                        <div>
                            <div class="stat-value">{{ stats.active_model }}</div>
                            <div class="stat-label">当前生图模型</div>
                        </div>
                    </div>
                </div>

                <!-- 搜索与筛选 -->
                <div class="toolbar">
                    <div class="search-box">
                        <span>🔍</span>
                        <input v-model="searchQuery" placeholder="搜索预设关键词或提示词内容..." />
                    </div>
                    <div class="filter-group">
                        <button class="btn btn-sm" :class="filterType === 'all' ? 'btn-primary' : 'btn-secondary'" @click="filterType = 'all'">
                            全部 ({{ prompts.length }})
                        </button>
                        <button class="btn btn-sm" :class="filterType === 'custom' ? 'btn-primary' : 'btn-secondary'" @click="filterType = 'custom'">
                            自定义 ({{ stats.custom_prompts_count }})
                        </button>
                        <button class="btn btn-sm" :class="filterType === 'builtin' ? 'btn-primary' : 'btn-secondary'" @click="filterType = 'builtin'">
                            内置 ({{ stats.total_prompts - stats.custom_prompts_count }})
                        </button>
                    </div>
                </div>

                <!-- 预设网格列表 -->
                <div v-if="loading" style="text-align: center; padding: 40px; color: var(--text-muted);">
                    加载中...
                </div>
                <div v-else-if="filteredPrompts.length === 0" style="text-align: center; padding: 60px; color: var(--text-muted);">
                    未找到匹配的预设提示词
                </div>
                <div v-else class="presets-grid">
                    <div v-for="item in filteredPrompts" :key="item.key" class="preset-card">
                        <div class="preset-header">
                            <div class="preset-title">
                                <span class="preset-name">#{{ item.key }}</span>
                                <span class="badge" :class="item.is_custom ? 'custom' : 'builtin'">
                                    {{ item.is_custom ? '自定义' : '内置' }}
                                </span>
                            </div>
                            <div class="card-actions">
                                <button class="btn btn-secondary btn-sm btn-icon" title="复制提示词" @click="copyPrompt(item)">📋</button>
                                <button class="btn btn-secondary btn-sm btn-icon" title="在测试台中运行" @click="applyPresetToTester(item)">⚡</button>
                                <button class="btn btn-secondary btn-sm btn-icon" title="编辑" @click="openEditModal(item)">✏️</button>
                                <button v-if="item.is_custom" class="btn btn-danger btn-sm btn-icon" title="删除" @click="deletePrompt(item)">🗑️</button>
                            </div>
                        </div>

                        <div class="preset-prompt">{{ item.prompt }}</div>

                        <div class="preset-footer">
                            <div class="ref-info" @click="openRefModal(item.key)">
                                <span>🖼️ 参考图: <b>{{ item.ref_image_count }}</b> 张</span>
                                <span style="text-decoration: underline; margin-left: 4px;">管理</span>
                            </div>
                            <span v-if="item.has_sample_image" style="font-size: 11px; color: var(--success);">
                                ● 已有生成样张
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 人设管理页面 -->
            <div v-if="currentTab === 'persona'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>人设与日常拍照管理</h1>
                        <p>配置 Bot 的外观特征、常用自拍场景和专属人物参考图。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-secondary" @click="openRefModal('_persona_')">
                            <span>📷</span> 人设参考图 ({{ personaForm.persona_ref_count }}张)
                        </button>
                        <button class="btn btn-primary" :disabled="personaForm.saving" @click="savePersona">
                            <span>💾</span> 保存人设配置
                        </button>
                    </div>
                </div>

                <div class="preset-card" style="margin-bottom: 24px;">
                    <div class="form-group">
                        <label class="form-label" style="display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" v-model="personaForm.enabled" style="width: 16px; height: 16px;" />
                            启用人设模式 (enable_persona_mode)
                        </label>
                        <p style="font-size: 12px; color: var(--text-muted);">
                            开启后，Bot 将能根据固定人物参考图和场景生成自拍照。
                        </p>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
                    <div class="preset-card">
                        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">👤 角色基本设定</h3>
                        <div class="form-group" style="margin-bottom: 14px;">
                            <label class="form-label">人设名称</label>
                            <input class="form-input" v-model="personaForm.name" placeholder="如：小助手、海梦" />
                        </div>
                        <div class="form-group" style="margin-bottom: 14px;">
                            <label class="form-label">人设外貌详细描述</label>
                            <textarea class="form-textarea" v-model="personaForm.description" placeholder="详细描述发型、发色、瞳色、服装偏好、常戴配饰等..."></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">默认照片风格</label>
                            <input class="form-input" v-model="personaForm.photo_style" placeholder="如：日常生活风格，自然光线，真实感" />
                        </div>
                    </div>

                    <div class="preset-card">
                        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">🌟 触发与默认场景</h3>
                        <div class="form-group" style="margin-bottom: 14px;">
                            <label class="form-label">默认场景提示词</label>
                            <textarea class="form-textarea" v-model="personaForm.default_prompt" placeholder="未匹配到具体场景时的兜底提示词..."></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">触发词列表 (逗号分隔)</label>
                            <input class="form-input" :value="personaForm.trigger_keywords.join(', ')" @input="personaForm.trigger_keywords = $event.target.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)" placeholder="拍照, 自拍, 看看你" />
                        </div>
                    </div>
                </div>

                <div class="preset-card">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                        <h3 style="font-size: 15px; font-weight: 600;">🏞️ 自定义场景列表</h3>
                        <button class="btn btn-secondary btn-sm" @click="addScene">➕ 添加场景</button>
                    </div>

                    <div v-if="personaForm.scenes.length === 0" style="color: var(--text-muted); font-size: 13px;">
                        暂无自定义场景映射。
                    </div>
                    <div v-else style="display: flex; flex-direction: column; gap: 10px;">
                        <div v-for="(scene, idx) in personaForm.scenes" :key="idx" style="display: flex; gap: 10px; align-items: center;">
                            <input class="form-input" style="width: 140px;" v-model="scene.name" placeholder="场景名(如: 咖啡店)" />
                            <input class="form-input" style="flex: 1;" v-model="scene.prompt" placeholder="场景对应提示词..." />
                            <button class="btn btn-danger btn-sm btn-icon" @click="removeScene(idx)">🗑️</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 在线测试工作台 -->
            <div v-if="currentTab === 'tester'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>在线生图测试</h1>
                        <p>快速验证文生图与图生图效果，直接获取模型返回结果与耗时指标。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-primary" :disabled="tester.loading" @click="runTestGenerate">
                            <span>{{ tester.loading ? '⏳ 正在生成...' : '🚀 开始生成' }}</span>
                        </button>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
                    <!-- 输入侧 -->
                    <div class="preset-card">
                        <div class="form-group" style="margin-bottom: 14px;">
                            <label class="form-label">提示词 (Prompt)</label>
                            <textarea class="form-textarea" style="min-height: 140px;" v-model="tester.prompt" placeholder="输入文生图描述，或图生图指令..."></textarea>
                        </div>

                        <div class="form-group" style="margin-bottom: 14px;">
                            <label class="form-label">参考输入图片 (可选，图生图)</label>
                            <div v-if="tester.inputImage" style="position: relative; width: 120px; height: 120px; margin-bottom: 8px;">
                                <img :src="tester.inputImage" style="width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-md);" />
                                <button class="ref-delete-btn" style="opacity: 1;" @click="tester.inputImage = ''">✕</button>
                            </div>
                            <input type="file" accept="image/*" @change="handleTesterImageUpload" />
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                            <div class="form-group">
                                <label class="form-label">模型</label>
                                <input class="form-input" v-model="tester.model" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">画质分辨率</label>
                                <select class="form-select" v-model="tester.resolution">
                                    <option value="1K">1K (标准)</option>
                                    <option value="2K">2K (高清)</option>
                                    <option value="4K">4K (超清)</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">宽高比</label>
                                <select class="form-select" v-model="tester.aspectRatio">
                                    <option value="1:1">1:1 (方图)</option>
                                    <option value="4:3">4:3</option>
                                    <option value="3:4">3:4</option>
                                    <option value="16:9">16:9</option>
                                    <option value="9:16">9:16 (竖屏)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- 输出侧 -->
                    <div class="preset-card" style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 380px;">
                        <div v-if="tester.loading" style="text-align: center; color: var(--text-secondary);">
                            <div style="font-size: 32px; margin-bottom: 12px;">🎨</div>
                            <div>正在调用绘图接口，请稍候...</div>
                        </div>
                        <div v-else-if="tester.resultImage" style="width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px;">
                            <img :src="tester.resultImage" style="max-width: 100%; max-height: 420px; border-radius: var(--radius-md); box-shadow: var(--shadow-lg);" />
                            <div style="font-size: 12px; color: var(--text-muted); text-align: center;">
                                模型: {{ tester.resultMeta.model }} ｜ 提供商: {{ tester.resultMeta.provider }} ｜ 耗时: {{ tester.resultMeta.duration }}
                            </div>
                        </div>
                        <div v-else style="color: var(--text-muted); font-size: 13px;">
                            生成结果将在此处展示
                        </div>
                    </div>
                </div>
            </div>

            <!-- 配置概览页面 -->
            <div v-if="currentTab === 'settings'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>接口与模型概览</h1>
                        <p>查看当前运行中插件的提供商链与配置状态。</p>
                    </div>
                </div>

                <div class="preset-card" style="margin-bottom: 20px;">
                    <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 14px;">⚙️ 全局接口参数</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px;">
                        <div>
                            <div class="stat-label">接口模式</div>
                            <div style="font-weight: 600; margin-top: 2px;">{{ stats.interface_mode }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认模型</div>
                            <div style="font-weight: 600; margin-top: 2px;">{{ stats.active_model }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认画质</div>
                            <div style="font-weight: 600; margin-top: 2px;">{{ stats.image_resolution }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认比例</div>
                            <div style="font-weight: 600; margin-top: 2px;">{{ stats.image_aspect_ratio }}</div>
                        </div>
                    </div>
                </div>

                <div class="preset-card">
                    <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 14px;">🔗 主备模型提供商链</h3>
                    <div v-if="stats.providers.length === 0" style="color: var(--text-muted);">
                        当前使用默认主提供商配置。
                    </div>
                    <div v-else style="display: flex; flex-direction: column; gap: 8px;">
                        <div v-for="p in stats.providers" :key="p.index" style="display: flex; justify-content: space-between; padding: 10px 14px; background-color: var(--bg-base); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                            <div>
                                <b>{{ p.index }}. {{ p.name }}</b>
                                <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">({{ p.interface_mode }} / {{ p.model }})</span>
                            </div>
                            <span class="badge" :class="p.enabled ? 'custom' : 'builtin'">{{ p.enabled ? '已启用' : '已停用' }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </main>

        <!-- 编辑预设模态框 -->
        <div v-if="editModal.show" class="modal-backdrop" @click.self="editModal.show = false">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title">{{ editModal.isNew ? '新增预设提示词' : '编辑预设提示词' }}</div>
                    <button class="btn btn-secondary btn-sm btn-icon" @click="editModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label">触发关键词 (触发命令，如: 手办化, 水墨风)</label>
                        <input class="form-input" v-model="editModal.key" :disabled="!editModal.isNew" placeholder="如: 赛博朋克" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">提示词内容 (Prompt)</label>
                        <textarea class="form-textarea" style="min-height: 160px;" v-model="editModal.prompt" placeholder="填写生成该风格时拼接的详细英文或中文 Prompt..."></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" @click="editModal.show = false">取消</button>
                    <button class="btn btn-primary" :disabled="editModal.saving" @click="savePrompt">
                        {{ editModal.saving ? '保存中...' : '确认保存' }}
                    </button>
                </div>
            </div>
        </div>

        <!-- 批量导入/导出模态框 -->
        <div v-if="ioModal.show" class="modal-backdrop" @click.self="ioModal.show = false">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title">{{ ioModal.mode === 'import' ? '批量导入预设提示词' : '导出预设提示词' }}</div>
                    <button class="btn btn-secondary btn-sm btn-icon" @click="ioModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <p v-if="ioModal.mode === 'import'" style="font-size: 12px; color: var(--text-muted);">
                        支持多行文本导入，每行格式为 <code>触发词:提示词</code>，或直接粘贴 JSON 格式字典。
                    </p>
                    <div class="form-group">
                        <textarea class="form-textarea" style="min-height: 220px; font-family: monospace;" v-model="ioModal.text" :readonly="ioModal.mode === 'export'" placeholder="手办化:3D figure, masterpiece...\n水墨风:Chinese ink painting..."></textarea>
                    </div>
                    <div v-if="ioModal.mode === 'import'" class="form-group">
                        <label style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
                            <input type="checkbox" v-model="ioModal.overwrite" />
                            遇到同名预设时覆盖
                        </label>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" @click="ioModal.show = false">{{ ioModal.mode === 'export' ? '关闭' : '取消' }}</button>
                    <button v-if="ioModal.mode === 'import'" class="btn btn-primary" :disabled="ioModal.loading" @click="executeImport">
                        {{ ioModal.loading ? '导入中...' : '开始导入' }}
                    </button>
                </div>
            </div>
        </div>

        <!-- 参考图管理模态框 -->
        <div v-if="refModal.show" class="modal-backdrop" @click.self="refModal.show = false">
            <div class="modal" style="max-width: 680px;">
                <div class="modal-header">
                    <div class="modal-title">🖼️ 参考图管理 - [{{ refModal.presetName === '_persona_' ? '人设参考图' : refModal.presetName }}]</div>
                    <button class="btn btn-secondary btn-sm btn-icon" @click="refModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 13px; color: var(--text-secondary);">共 {{ refModal.images.length }} 张参考图</span>
                        <button v-if="refModal.images.length > 0" class="btn btn-danger btn-sm" @click="clearAllRefImages">清空全部</button>
                    </div>

                    <div v-if="refModal.loading" style="text-align: center; padding: 20px; color: var(--text-muted);">
                        正在加载参考图...
                    </div>
                    <div v-else class="ref-grid">
                        <div v-for="img in refModal.images" :key="img.index" class="ref-item">
                            <img :src="img.data_url" />
                            <button class="ref-delete-btn" title="删除这张" @click="deleteRefImage(img.index)">✕</button>
                        </div>
                    </div>

                    <!-- 上传区域 -->
                    <label class="upload-dropzone">
                        <input type="file" multiple accept="image/*" style="display: none;" @change="handleFileUpload" />
                        <div style="font-size: 24px; margin-bottom: 6px;">📤</div>
                        <div style="font-size: 13px; font-weight: 500;">点击上传新的参考图片</div>
                        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">支持多选 PNG/JPG/WEBP</div>
                    </label>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" @click="refModal.show = false">完成</button>
                </div>
            </div>
        </div>

        <!-- 悬浮通知 -->
        <div v-if="toast.show" class="toast" :class="toast.type">
            <span>{{ toast.type === 'success' ? '✅' : '❌' }}</span>
            <span>{{ toast.message }}</span>
        </div>
    </div>
    `
}).mount('#app');
