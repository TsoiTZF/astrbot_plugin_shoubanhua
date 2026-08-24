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
        const qs = new URLSearchParams(params).toString();
        const url = `/astrbot_plugin_shoubanhua/page/${endpoint}${qs ? '?' + qs : ''}`;
        const res = await fetch(url);
        return await res.json();
    }

    async post(endpoint, body = {}) {
        if (this.bridge && typeof this.bridge.apiPost === 'function') {
            return await this.bridge.apiPost(`page/${endpoint}`, body);
        }
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
            active_model: 'gpt-image-2',
            image_resolution: '4K',
            image_aspect_ratio: '4:3',
            interface_mode: 'openai_image',
            enable_persona_mode: false,
            providers: [],
        });

        const prompts = ref([]);
        const searchQuery = ref('');
        const filterCategory = ref('all'); // all | custom | figurine | cosplay | scene | anime

        // 编辑模态框
        const editModal = reactive({
            show: false,
            isNew: true,
            key: '',
            originalKey: '',
            prompt: '',
            saving: false,
        });

        // 导入导出模态框
        const ioModal = reactive({
            show: false,
            mode: 'import',
            text: '',
            overwrite: true,
            loading: false,
        });

        // 参考图模态框
        const refModal = reactive({
            show: false,
            presetName: '',
            images: [],
            loading: false,
            uploading: false,
        });

        // 人设管理
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
            resolution: '4K',
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

        const unwrapApiResponse = (res) => {
            if (res && res.status === 'error') {
                const msg = res.message || '请求处理失败';
                showToast(msg, 'error');
                throw new Error(msg);
            }
            // AstrBot Plugin Page Bridge 通常会自动解包标准响应的 data；
            // 直接访问回退模式则仍可能返回 {status, data}，两种结构都要兼容。
            if (res && res.status === 'ok' && Object.prototype.hasOwnProperty.call(res, 'data')) {
                return res.data;
            }
            return res ?? {};
        };

        const fetchBootstrap = async () => {
            try {
                const data = unwrapApiResponse(await client.get('bootstrap'));
                Object.assign(stats, data);
                tester.model = stats.active_model;
                tester.resolution = stats.image_resolution;
                tester.aspectRatio = stats.image_aspect_ratio;
            } catch (e) {}
        };

        const fetchPrompts = async () => {
            loading.value = true;
            try {
                const data = unwrapApiResponse(await client.get('prompts'));
                prompts.value = Array.isArray(data) ? data : [];
                stats.total_prompts = prompts.value.length;
                stats.custom_prompts_count = prompts.value.filter(p => p.is_custom).length;
            } finally {
                loading.value = false;
            }
        };

        const fetchPersona = async () => {
            try {
                const data = unwrapApiResponse(await client.get('persona'));
                Object.assign(personaForm, data);
            } catch (e) {}
        };

        // 分类推断器
        const inferCategory = (item) => {
            if (item.is_custom) return 'custom';
            const k = item.key.toLowerCase();
            if (k.includes('手办') || k.includes('3d') || k.includes('pvc') || k.includes('模型')) return 'figurine';
            if (k.includes('cos') || k.includes('真人')) return 'cosplay';
            if (k.includes('痛') || k.includes('视角') || k.includes('景') || k.includes('车')) return 'scene';
            return 'anime';
        };

        const filteredPrompts = computed(() => {
            return prompts.value.filter(p => {
                const q = searchQuery.value.trim().toLowerCase();
                const matchQuery = !q || 
                    p.key.toLowerCase().includes(q) ||
                    p.prompt.toLowerCase().includes(q);
                
                if (!matchQuery) return false;
                if (filterCategory.value === 'all') return true;
                if (filterCategory.value === 'custom') return p.is_custom;
                return inferCategory(p) === filterCategory.value;
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
            editModal.prompt = item.prompt;
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
            showToast(`已复制 [${item.key}] 提示词`);
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
                const data = unwrapApiResponse(await client.get('prompts/export'));
                ioModal.text = data.text || '';
            } finally {
                ioModal.loading = false;
            }
        };

        const executeImport = async () => {
            if (!ioModal.text.trim()) return showToast('请输入要导入的预设文本', 'error');
            ioModal.loading = true;
            try {
                const res = await client.post('prompts/import', {
                    text: ioModal.text,
                    overwrite: ioModal.overwrite,
                });
                const data = unwrapApiResponse(res);
                showToast(res?.message || data?.message || '导入完成');
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
                const data = unwrapApiResponse(await client.get('ref-images', { preset_name: presetName }));
                refModal.images = data.images || [];
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
                const data = unwrapApiResponse(await client.post('test-generate', {
                    prompt: tester.prompt,
                    input_image: tester.inputImage,
                    model: tester.model,
                    aspect_ratio: tester.aspectRatio,
                    resolution: tester.resolution,
                }));
                tester.resultImage = data.image_url;
                tester.resultMeta = data;
                showToast('生成成功');
            } finally {
                tester.loading = false;
            }
        };

        const applyPresetToTester = (item) => {
            tester.prompt = item.prompt;
            currentTab.value = 'tester';
            showToast(`已载入预设 [${item.key}] 到测试工作台`);
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
            filterCategory,
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
                    <div style="font-size: 11.5px; color: var(--text-muted);">提示词与人设工作台</div>
                </div>
                <span class="brand-badge">v{{ stats.version }}</span>
            </div>
            <nav class="nav">
                <div class="nav-item" :class="{ active: currentTab === 'prompts' }" @click="currentTab = 'prompts'">
                    <span class="icon">📋</span> 预设提示词库
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'persona' }" @click="currentTab = 'persona'">
                    <span class="icon">👤</span> 人设与场景中心
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'tester' }" @click="currentTab = 'tester'">
                    <span class="icon">⚡</span> 在线生图测试
                </div>
                <div class="nav-item" :class="{ active: currentTab === 'settings' }" @click="currentTab = 'settings'">
                    <span class="icon">⚙️</span> 接口与提供商
                </div>
            </nav>
            <div style="padding: 16px 20px; font-size: 12px; color: var(--text-dim); border-top: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between;">
                <span>AstrBot Plugin WebUI</span>
                <span style="display: inline-block; width: 6px; height: 6px; border-radius: 9999px; background: var(--accent-emerald);"></span>
            </div>
        </aside>

        <!-- 主内容区 -->
        <main class="main-content">
            <!-- 预设管理页面 -->
            <div v-if="currentTab === 'prompts'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>预设提示词库</h1>
                        <p>统一调优内置与自定义图生图风格预设，实时管理专属参考图。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-secondary" @click="openExportModal">
                            <span>📤</span> 导出预设
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
                        <div class="stat-icon indigo">📚</div>
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
                        <div class="stat-icon cyan">🎯</div>
                        <div>
                            <div class="stat-value">{{ stats.active_model }}</div>
                            <div class="stat-label">默认生图模型</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon emerald">💎</div>
                        <div>
                            <div class="stat-value">{{ stats.image_resolution }}</div>
                            <div class="stat-label">默认输出画质</div>
                        </div>
                    </div>
                </div>

                <!-- 搜索与筛选 -->
                <div class="toolbar">
                    <div class="search-box">
                        <span>🔍</span>
                        <input v-model="searchQuery" placeholder="搜索触发词、关键词或提示词细节..." />
                    </div>
                    <div class="filter-group">
                        <button class="filter-btn" :class="{ active: filterCategory === 'all' }" @click="filterCategory = 'all'">
                            全部 ({{ prompts.length }})
                        </button>
                        <button class="filter-btn" :class="{ active: filterCategory === 'custom' }" @click="filterCategory = 'custom'">
                            自定义 ({{ stats.custom_prompts_count }})
                        </button>
                        <button class="filter-btn" :class="{ active: filterCategory === 'figurine' }" @click="filterCategory = 'figurine'">
                            手办PVC
                        </button>
                        <button class="filter-btn" :class="{ active: filterCategory === 'cosplay' }" @click="filterCategory = 'cosplay'">
                            Cosplay
                        </button>
                        <button class="filter-btn" :class="{ active: filterCategory === 'scene' }" @click="filterCategory = 'scene'">
                            场景痛屋
                        </button>
                        <button class="filter-btn" :class="{ active: filterCategory === 'anime' }" @click="filterCategory = 'anime'">
                            二次元/衍生
                        </button>
                    </div>
                </div>

                <!-- 预设网格列表 -->
                <div v-if="loading" style="text-align: center; padding: 60px; color: var(--text-muted);">
                    <div style="font-size: 28px; margin-bottom: 8px;">⏳</div>
                    <div>正在同步预设提示词库...</div>
                </div>
                <div v-else-if="filteredPrompts.length === 0" style="text-align: center; padding: 80px; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-lg); border: 1px solid var(--border-subtle);">
                    <div style="font-size: 32px; margin-bottom: 10px;">🔍</div>
                    <div style="font-size: 15px; font-weight: 600; color: var(--text-secondary);">未找到匹配的预设</div>
                    <div style="font-size: 13px; margin-top: 4px;">可以尝试清空搜索条件或点击右上角「新增预设」</div>
                </div>
                <div v-else class="presets-grid">
                    <div v-for="item in filteredPrompts" :key="item.key" class="preset-card">
                        <div class="preset-header">
                            <div class="preset-title">
                                <span class="preset-name" :title="item.key">#{{ item.key }}</span>
                                <span class="badge" :class="item.is_custom ? 'custom' : 'builtin'">
                                    {{ item.is_custom ? '自定义' : '内置' }}
                                </span>
                            </div>
                            <div class="card-actions">
                                <button class="btn btn-secondary btn-icon" title="复制完整提示词" @click="copyPrompt(item)">📋</button>
                                <button class="btn btn-secondary btn-icon" title="在测试工作台中运行" @click="applyPresetToTester(item)">⚡</button>
                                <button class="btn btn-secondary btn-icon" title="编辑提示词" @click="openEditModal(item)">✏️</button>
                                <button v-if="item.is_custom" class="btn btn-danger btn-icon" title="删除预设" @click="deletePrompt(item)">🗑️</button>
                            </div>
                        </div>

                        <div class="preset-prompt-box">{{ item.prompt }}</div>

                        <div class="preset-footer">
                            <div class="ref-badge-btn" @click="openRefModal(item.key)">
                                <span>🖼️ 参考图 <b>{{ item.ref_image_count }}</b></span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span v-if="item.has_sample_image" style="font-size: 11.5px; color: var(--accent-emerald);">
                                    ● 样张已就绪
                                </span>
                                <span style="font-size: 11.5px; color: var(--text-dim);">
                                    {{ item.prompt.length }} 字符
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 人设管理页面 -->
            <div v-if="currentTab === 'persona'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>人设与日常拍照中心</h1>
                        <p>定制专属虚拟形象外观设定、自拍触发词和专属人物参考底图。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-secondary" @click="openRefModal('_persona_')">
                            <span>📷</span> 人设底图库 ({{ personaForm.persona_ref_count }} 张)
                        </button>
                        <button class="btn btn-primary" :disabled="personaForm.saving" @click="savePersona">
                            <span>💾</span> {{ personaForm.saving ? '保存中...' : '保存人设设定' }}
                        </button>
                    </div>
                </div>

                <div class="stat-card" style="margin-bottom: 24px;">
                    <div class="stat-icon purple">👤</div>
                    <div style="flex: 1;">
                        <label style="display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; cursor: pointer;">
                            <input type="checkbox" v-model="personaForm.enabled" style="width: 18px; height: 18px; accent-color: var(--primary);" />
                            开启日常人设拍照模式 (enable_persona_mode)
                        </label>
                        <p style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">
                            开启后，用户发送“看看你 / 拍张照 / 自拍”等指令时，Bot 将基于固定人物参考图和场景自动出图。
                        </p>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px;">
                    <div class="stat-card" style="display: block;">
                        <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
                            <span>✨</span> 形象外观描述
                        </h3>
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label class="form-label">角色名称</label>
                            <input class="form-input" v-model="personaForm.name" placeholder="如：小助手、海梦、云瑶" />
                        </div>
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label class="form-label">外貌与特征详细描述</label>
                            <textarea class="form-textarea" style="min-height: 110px;" v-model="personaForm.description" placeholder="详细描述发型、发色、瞳色、服装、常戴配饰等..."></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">默认摄影风格</label>
                            <input class="form-input" v-model="personaForm.photo_style" placeholder="如：日常生活风格，自然光线，真实感" />
                        </div>
                    </div>

                    <div class="stat-card" style="display: block;">
                        <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
                            <span>🎯</span> 触发词与默认场景
                        </h3>
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label class="form-label">默认场景提示词</label>
                            <textarea class="form-textarea" style="min-height: 110px;" v-model="personaForm.default_prompt" placeholder="未命中特定场景时的兜底提示词..."></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">拍照触发词 (支持逗号分隔)</label>
                            <input class="form-input" :value="personaForm.trigger_keywords.join(', ')" @input="personaForm.trigger_keywords = $event.target.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)" placeholder="拍照, 自拍, 看看你, 露脸" />
                        </div>
                    </div>
                </div>

                <div class="stat-card" style="display: block;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                        <h3 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
                            <span>🏞️</span> 自定义场景提示词映射
                        </h3>
                        <button class="btn btn-secondary btn-sm" @click="addScene">➕ 添加场景</button>
                    </div>

                    <div v-if="personaForm.scenes.length === 0" style="color: var(--text-muted); font-size: 13px; padding: 20px; text-align: center;">
                        暂无自定义场景。点击右上角可添加如「咖啡店:在咖啡馆喝咖啡」等映射。
                    </div>
                    <div v-else style="display: flex; flex-direction: column; gap: 12px;">
                        <div v-for="(scene, idx) in personaForm.scenes" :key="idx" style="display: flex; gap: 12px; align-items: center;">
                            <input class="form-input" style="width: 160px; flex-shrink: 0;" v-model="scene.name" placeholder="场景名 (如: 咖啡店)" />
                            <input class="form-input" style="flex: 1;" v-model="scene.prompt" placeholder="场景提示词 (如: 在午后咖啡馆靠窗坐着悠闲喝咖啡...)" />
                            <button class="btn btn-danger btn-icon" title="删除场景" @click="removeScene(idx)">🗑️</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 在线测试工作台 -->
            <div v-if="currentTab === 'tester'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>在线生图测试台</h1>
                        <p>实时调试提示词效果，直观查看耗时、模型和最终出图质量。</p>
                    </div>
                    <div class="header-actions">
                        <button class="btn btn-primary" :disabled="tester.loading" @click="runTestGenerate">
                            <span>{{ tester.loading ? '⏳ 正在出图中...' : '🚀 开始生成' }}</span>
                        </button>
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
                    <!-- 输入面板 -->
                    <div class="stat-card" style="display: block;">
                        <div class="form-group" style="margin-bottom: 16px;">
                            <label class="form-label">生成提示词 (Prompt)</label>
                            <textarea class="form-textarea" style="min-height: 140px;" v-model="tester.prompt" placeholder="输入文生图或图生图提示词..."></textarea>
                        </div>

                        <div class="form-group" style="margin-bottom: 16px;">
                            <label class="form-label">参考输入图片 (可选，图生图)</label>
                            <div v-if="tester.inputImage" style="position: relative; width: 140px; height: 140px; margin-bottom: 10px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-glass);">
                                <img :src="tester.inputImage" style="width: 100%; height: 100%; object-fit: cover;" />
                                <button class="ref-delete-btn" style="opacity: 1;" @click="tester.inputImage = ''">✕</button>
                            </div>
                            <input type="file" accept="image/*" @change="handleTesterImageUpload" />
                        </div>

                        <div style="display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 12px;">
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
                                    <option value="3:4">3:4 (常规)</option>
                                    <option value="16:9">16:9 (横屏)</option>
                                    <option value="9:16">9:16 (竖屏)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- 结果预览面板 -->
                    <div class="stat-card" style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 420px; position: relative;">
                        <div v-if="tester.loading" style="text-align: center; color: var(--text-secondary);">
                            <div style="font-size: 36px; margin-bottom: 12px;">🎨</div>
                            <div style="font-size: 15px; font-weight: 600;">正在调用绘图模型...</div>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">超清 4K 图生图可能需要 1~2 分钟</div>
                        </div>
                        <div v-else-if="tester.resultImage" style="width: 100%; display: flex; flex-direction: column; align-items: center; gap: 14px;">
                            <img :src="tester.resultImage" style="max-width: 100%; max-height: 460px; border-radius: var(--radius-md); box-shadow: var(--shadow-md); border: 1px solid var(--border-glass);" />
                            <div style="font-size: 12.5px; color: var(--text-secondary); background: var(--bg-input); padding: 8px 16px; border-radius: 9999px; border: 1px solid var(--border-subtle);">
                                模型: <b>{{ tester.resultMeta.model }}</b> ｜ 耗时: <b>{{ tester.resultMeta.duration }}</b>
                            </div>
                        </div>
                        <div v-else style="color: var(--text-muted); text-align: center;">
                            <div style="font-size: 36px; margin-bottom: 8px; opacity: 0.5;">🖼️</div>
                            <div>生图结果将在此实时渲染</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 配置概览页面 -->
            <div v-if="currentTab === 'settings'">
                <div class="header-bar">
                    <div class="page-title">
                        <h1>接口与提供商概览</h1>
                        <p>查看当前运行中插件的提供商链与配置状态。</p>
                    </div>
                </div>

                <div class="stat-card" style="display: block; margin-bottom: 24px;">
                    <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px;">⚙️ 全局接口参数</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">
                        <div>
                            <div class="stat-label">接口模式 (interface_mode)</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 4px;">{{ stats.interface_mode }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认模型 (model)</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 4px;">{{ stats.active_model }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认分辨率 (image_resolution)</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 4px;">{{ stats.image_resolution }}</div>
                        </div>
                        <div>
                            <div class="stat-label">默认宽高比 (image_aspect_ratio)</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 4px;">{{ stats.image_aspect_ratio }}</div>
                        </div>
                    </div>
                </div>

                <div class="stat-card" style="display: block;">
                    <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 16px;">🔗 主备模型提供商链</h3>
                    <div v-if="stats.providers.length === 0" style="color: var(--text-muted); padding: 12px 0;">
                        当前使用默认主提供商配置。
                    </div>
                    <div v-else style="display: flex; flex-direction: column; gap: 10px;">
                        <div v-for="p in stats.providers" :key="p.index" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; background: var(--bg-input); border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
                            <div>
                                <span style="font-weight: 700; font-size: 14px;">{{ p.index }}. {{ p.name }}</span>
                                <span style="font-size: 12.5px; color: var(--text-muted); margin-left: 10px;">({{ p.interface_mode }} ｜ {{ p.model }})</span>
                            </div>
                            <span class="badge" :class="p.enabled ? 'custom' : 'builtin'">{{ p.enabled ? '运行中' : '已停用' }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </main>

        <!-- 编辑预设模态框 -->
        <div v-if="editModal.show" class="modal-backdrop" @click.self="editModal.show = false">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title">{{ editModal.isNew ? '✨ 新增预设提示词' : '✏️ 编辑预设提示词' }}</div>
                    <button class="btn btn-secondary btn-icon" @click="editModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label">触发词 (命令名称，如: 手办化, 水墨风, 站街)</label>
                        <input class="form-input" v-model="editModal.key" :disabled="!editModal.isNew" placeholder="例如: 赛博朋克" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">提示词正文 (Prompt)</label>
                        <textarea class="form-textarea" style="min-height: 180px; font-family: ui-monospace, monospace;" v-model="editModal.prompt" placeholder="填写生成该预设时拼接的详细提示词内容..."></textarea>
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
                    <div class="modal-title">{{ ioModal.mode === 'import' ? '📥 批量导入预设提示词' : '📤 导出预设提示词' }}</div>
                    <button class="btn btn-secondary btn-icon" @click="ioModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <p v-if="ioModal.mode === 'import'" style="font-size: 13px; color: var(--text-muted);">
                        每行填写一个预设，格式为 <code>触发词:提示词内容</code>，或直接粘贴 JSON 字典。
                    </p>
                    <div class="form-group">
                        <textarea class="form-textarea" style="min-height: 240px; font-family: ui-monospace, monospace; font-size: 12.5px;" v-model="ioModal.text" :readonly="ioModal.mode === 'export'" placeholder="手办化:3D PVC figure, masterpiece...\n赛博风:Cyberpunk city, neon light..."></textarea>
                    </div>
                    <div v-if="ioModal.mode === 'import'" class="form-group">
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" v-model="ioModal.overwrite" style="accent-color: var(--primary);" />
                            遇到同名预设时自动覆盖
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
            <div class="modal" style="max-width: 720px;">
                <div class="modal-header">
                    <div class="modal-title">🖼️ 参考图库 - [{{ refModal.presetName === '_persona_' ? '人设底图' : refModal.presetName }}]</div>
                    <button class="btn btn-secondary btn-icon" @click="refModal.show = false">✕</button>
                </div>
                <div class="modal-body">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 13px; color: var(--text-secondary);">已绑定 <b>{{ refModal.images.length }}</b> 张参考图</span>
                        <button v-if="refModal.images.length > 0" class="btn btn-danger btn-sm" @click="clearAllRefImages">清空全部</button>
                    </div>

                    <div v-if="refModal.loading" style="text-align: center; padding: 30px; color: var(--text-muted);">
                        正在加载参考图...
                    </div>
                    <div v-else-if="refModal.images.length === 0" style="text-align: center; padding: 20px 0; color: var(--text-muted); font-size: 13px;">
                        暂无已绑定的参考图片
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
                        <div style="font-size: 28px; margin-bottom: 8px;">📤</div>
                        <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">点击上传新的参考图片</div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">支持批量选择 PNG / JPG / WEBP</div>
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
