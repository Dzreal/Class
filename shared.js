// 班级工具箱共用的轻量辅助函数。
// 保持原生 JavaScript，不依赖构建工具，所有页面都可直接静态部署。
(function (global) {
    'use strict';

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // GitHub Contents API 的每一段路径都要分别编码，中文与空格才能稳定使用。
    function encodeGitHubPath(path) {
        return String(path ?? '')
            .split('/')
            .filter(Boolean)
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    // 云端记录名称最终会成为文件名，拦截 Windows/GitHub 路径中的危险字符。
    function validateCloudFileName(name) {
        const trimmed = String(name ?? '').trim();
        if (!trimmed || trimmed.length > 60) return false;
        if (trimmed === '.' || trimmed === '..') return false;
        return !/[\\/:*?"<>|#%]/.test(trimmed);
    }

    function validateGitHubRelativePath(path) {
        const segments = String(path ?? '').split('/');
        return segments.length > 0 && segments.every(segment => validateCloudFileName(segment));
    }

    // Fisher-Yates 洗牌保证每一种排列出现的概率一致。
    function shuffleInPlace(items, random = Math.random) {
        for (let index = items.length - 1; index > 0; index--) {
            const targetIndex = Math.floor(random() * (index + 1));
            [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
        }
        return items;
    }

    function cloneJson(data) {
        return JSON.parse(JSON.stringify(data));
    }

    const STUDENT_LIST_SCHEMA_VERSION = 3;
    const CURRENT_STUDENT_LIST_FILE_KEY = 'classToolsCurrentStudentListFile';

    // 老座位表没有学号时，根据姓名和原顺序生成稳定的兼容 ID。
    // 这个 ID 只负责迁移旧数据；一旦与投票名单合并，就会优先使用真实学号。
    function createLegacyStudentId(name, index) {
        const source = `${String(name ?? '').trim()}\u0000${index}`;
        let hash = 2166136261;
        for (let position = 0; position < source.length; position++) {
            hash ^= source.charCodeAt(position);
            hash = Math.imul(hash, 16777619);
        }
        return `legacy-${(hash >>> 0).toString(36)}`;
    }

    // 投票页和座位页共用这一套学生格式，同时接受旧数组和新版名单文档。
    function normalizeStudentList(source) {
        const rawStudents = Array.isArray(source)
            ? source
            : (source && Array.isArray(source.students) ? source.students : []);
        const usedIds = new Set();

        return rawStudents.slice(0, 500).map((student, index) => {
            const name = String(student?.name ?? '').trim().slice(0, 100);
            let id = String(student?.id ?? student?.studentId ?? '').trim().slice(0, 100);
            if (!id) id = createLegacyStudentId(name, index);

            const baseId = id;
            let suffix = 2;
            while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
            usedIds.add(id);

            const gender = student?.gender === '男' || student?.gender === '女' ? student.gender : '';
            return { id, name, gender };
        }).filter(student => student.name);
    }

    function normalizeStudentListDocument(source, fallbackClassName = '') {
        const safeSource = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
        return {
            schemaVersion: STUDENT_LIST_SCHEMA_VERSION,
            className: String(safeSource.className ?? fallbackClassName).trim().slice(0, 60),
            updatedAt: Number(safeSource.updatedAt) || 0,
            students: normalizeStudentList(source)
        };
    }

    function createStudentListDocument(students, className = '') {
        return {
            schemaVersion: STUDENT_LIST_SCHEMA_VERSION,
            className: String(className ?? '').trim().slice(0, 60),
            updatedAt: Date.now(),
            students: normalizeStudentList(students)
        };
    }

    function isStudentListFile(path) {
        const safePath = String(path ?? '').trim();
        return /^classes\/[^/]+\/roster\.json$/i.test(safePath) && validateGitHubRelativePath(safePath);
    }

    // 两个页面只记住“当前班级名单”，这是内部状态，不需要用户在排座页重复选择。
    function loadCurrentStudentListFile(legacyKeys = [], storageKey = CURRENT_STUDENT_LIST_FILE_KEY) {
        let path = localStorage.getItem(storageKey) || '';
        if (!isStudentListFile(path)) {
            path = '';
            for (const key of legacyKeys) {
                const legacyPath = localStorage.getItem(key) || '';
                if (isStudentListFile(legacyPath)) {
                    path = legacyPath;
                    break;
                }
            }
        }
        if (path) localStorage.setItem(storageKey, path);
        legacyKeys.forEach(key => localStorage.removeItem(key));
        return path;
    }

    function saveCurrentStudentListFile(path, storageKey = CURRENT_STUDENT_LIST_FILE_KEY) {
        const safePath = isStudentListFile(path) ? String(path).trim() : '';
        if (safePath) localStorage.setItem(storageKey, safePath);
        else localStorage.removeItem(storageKey);
        return safePath;
    }

    function getClassNameFromRosterPath(path) {
        const match = /^classes\/([^/]+)\/roster\.json$/i.exec(String(path || ''));
        return match ? match[1] : '';
    }

    function getClassDataPaths(className) {
        const safeName = String(className || '').trim();
        if (!validateCloudFileName(safeName)) return null;
        const root = `classes/${safeName}`;
        return Object.freeze({
            className: safeName,
            root,
            roster: `${root}/roster.json`,
            seat: `${root}/seat.json`,
            votes: `${root}/votes`
        });
    }

    function normalizeSpreadsheetHeader(value) {
        return String(value ?? '')
            .replace(/^\uFEFF/, '')
            .replace(/[\s：:]/g, '')
            .trim()
            .toLowerCase();
    }

    // Windows/Excel 导出的 CSV 既可能是 UTF-8，也可能是 GBK（GB18030）。
    // 两种编码都尝试，并优先采用能识别出学生名单列头的结果。
    function readSpreadsheetRows(arrayBuffer, fileName = '') {
        if (!global.XLSX) throw new Error('Excel 解析组件尚未加载，请刷新页面后重试');

        const workbookToRows = workbook => {
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            if (!firstSheet) throw new Error('文件中没有可读取的工作表');
            return global.XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: '' });
        };
        const parseText = text => workbookToRows(global.XLSX.read(
            String(text || '').replace(/^\uFEFF/, ''),
            { type: 'string', raw: true }
        ));

        if (/\.csv$/i.test(String(fileName || ''))) {
            const bytes = new Uint8Array(arrayBuffer);
            const candidates = [];
            for (const encoding of ['utf-8', 'gb18030']) {
                try {
                    const text = new TextDecoder(encoding).decode(bytes);
                    const rows = parseText(text);
                    const firstRows = rows.slice(0, 10).flat().map(normalizeSpreadsheetHeader);
                    const headerScore = firstRows.filter(value => [
                        'id', 'studentid', '学号', '编号', '学生编号',
                        '姓名', '名字', '学生姓名', '性别', '学生性别'
                    ].includes(value)).length;
                    const replacementPenalty = (text.match(/�/g) || []).length;
                    candidates.push({ rows, score: headerScore * 100 - replacementPenalty });
                } catch (error) {
                    console.warn(`使用 ${encoding} 解析 CSV 失败`, error);
                }
            }
            if (candidates.length === 0) throw new Error('无法识别 CSV 文件编码');
            candidates.sort((a, b) => b.score - a.score);
            return candidates[0].rows;
        }

        return workbookToRows(global.XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' }));
    }

    const SHARED_TOKEN_KEY = 'classToolsGitHubToken';

    // 三个工具共用一份 Token，并自动迁移旧版本使用的不同存储名称。
    function loadGitHubToken(legacyKeys = []) {
        let token = localStorage.getItem(SHARED_TOKEN_KEY) || '';
        if (!token) {
            for (const key of legacyKeys) {
                token = localStorage.getItem(key) || '';
                if (token) break;
            }
        }
        if (token) localStorage.setItem(SHARED_TOKEN_KEY, token);
        legacyKeys.forEach(key => localStorage.removeItem(key));
        return token;
    }

    function saveGitHubToken(token) {
        const trimmed = String(token ?? '').trim();
        if (trimmed) localStorage.setItem(SHARED_TOKEN_KEY, trimmed);
        else localStorage.removeItem(SHARED_TOKEN_KEY);
    }

    // 创建一个设备本地的滚动备份仓库，仅用于误操作恢复；云端 GitHub 仍是跨设备数据源。
    function createJsonBackupManager(storageKey, maxBackups = 10) {
        function list() {
            try {
                const backups = JSON.parse(localStorage.getItem(storageKey)) || [];
                return Array.isArray(backups) ? backups : [];
            } catch (error) {
                console.error(`读取本地备份失败：${storageKey}`, error);
                return [];
            }
        }

        function snapshot(data, reason) {
            try {
                const safeData = cloneJson(data);
                const backups = list();
                const serialized = JSON.stringify(safeData);

                if (backups[0] && JSON.stringify(backups[0].data) === serialized) {
                    return { ok: true, skipped: true };
                }

                const now = Date.now();
                backups.unshift({
                    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
                    createdAt: now,
                    reason,
                    data: safeData
                });
                localStorage.setItem(storageKey, JSON.stringify(backups.slice(0, maxBackups)));
                return { ok: true, skipped: false };
            } catch (error) {
                console.error(`保存本地备份失败：${storageKey}`, error);
                return { ok: false, error };
            }
        }

        function get(id) {
            const backup = list().find(item => item.id === id);
            return backup ? cloneJson(backup) : null;
        }

        // “撤销上一步”成功恢复后移除已使用的快照，连续点击即可逐步往回撤销。
        function remove(id) {
            try {
                const backups = list();
                const remaining = backups.filter(item => item.id !== id);
                localStorage.setItem(storageKey, JSON.stringify(remaining));
                return remaining.length !== backups.length;
            } catch (error) {
                console.error(`移除本地备份失败：${storageKey}`, error);
                return false;
            }
        }

        return Object.freeze({ list, snapshot, get, remove, maxBackups });
    }

    global.ClassTools = Object.freeze({
        createStudentListDocument,
        createJsonBackupManager,
        encodeGitHubPath,
        escapeHtml,
        getClassDataPaths,
        getClassNameFromRosterPath,
        loadGitHubToken,
        loadCurrentStudentListFile,
        normalizeStudentList,
        normalizeStudentListDocument,
        normalizeSpreadsheetHeader,
        readSpreadsheetRows,
        saveCurrentStudentListFile,
        saveGitHubToken,
        shuffleInPlace,
        studentListSchemaVersion: STUDENT_LIST_SCHEMA_VERSION,
        validateCloudFileName,
        validateGitHubRelativePath
    });
})(window);
