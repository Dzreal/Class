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

        return Object.freeze({ list, snapshot, get, maxBackups });
    }

    global.ClassTools = Object.freeze({
        createJsonBackupManager,
        encodeGitHubPath,
        escapeHtml,
        loadGitHubToken,
        saveGitHubToken,
        shuffleInPlace,
        validateCloudFileName,
        validateGitHubRelativePath
    });
})(window);
