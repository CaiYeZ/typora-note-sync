const __core = window[Symbol.for("typora-plugin-core@v2")];
const { Notice, Plugin, PluginSettings, SettingTab } = __core;
const { editor, reqnode } = window;
const { spawn } = reqnode('child_process');
const processEnv = reqnode('process').env;
export const DEFAULT_SETTINGS = {
    repoPath: '',
    gitExecutable: 'git',
    remote: 'origin',
    branch: '',
    commitMode: 'timestamp',
    commitTemplate: 'sync: {datetime}',
    timestampPrefix: 'sync',
    autoSyncOnStart: false,
    autoSyncOnSave: false,
    saveSyncDelaySeconds: 5,
    autoSyncIntervalMinutes: 0,
    noticeDurationMs: 3000,
};
export default class NoteSyncPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.operation = null;
        this.intervalTimer = null;
        this.saveTimer = null;
        this.lastResult = '尚未操作';
        this.settingTab = null;
    }
    onload() {
        this.registerSettings(new PluginSettings(this.app, this.manifest, { version: 1 }));
        this.settings.setDefault(DEFAULT_SETTINGS);
        this.registerCommand({
            id: 'sync-now',
            title: 'GitHub：提交并推送笔记',
            scope: 'global',
            hotkey: 'Ctrl+Alt+S',
            callback: () => void this.syncNow('manual'),
        });
        this.registerCommand({
            id: 'pull-now',
            title: 'GitHub：手动拉取笔记',
            scope: 'global',
            callback: () => void this.pullNow('manual'),
        });
        const pullIcon = document.createElement('i');
        pullIcon.className = 'fa fa-download';
        this.register(this.app.workspace.ribbon.addButton({
            id: `${this.manifest.id}.pull-now`,
            title: '从 GitHub 拉取笔记',
            icon: pullIcon,
            onclick: () => void this.pullNow('manual'),
        }));
        const syncIcon = document.createElement('i');
        syncIcon.className = 'fa fa-upload';
        this.register(this.app.workspace.ribbon.addButton({
            id: `${this.manifest.id}.sync-now`,
            title: '提交并推送笔记到 GitHub',
            icon: syncIcon,
            onclick: () => void this.syncNow('manual'),
        }));
        this.settingTab = new NoteSyncSettingTab(this);
        this.registerSettingTab(this.settingTab);
        this.register(this.app.workspace.on('file:will-save', () => {
            if (!this.settings.get('autoSyncOnSave'))
                return;
            if (this.saveTimer)
                clearTimeout(this.saveTimer);
            const delay = Math.max(1, Number(this.settings.get('saveSyncDelaySeconds')) || 5) * 1000;
            this.saveTimer = setTimeout(() => {
                this.saveTimer = null;
                void this.syncNow('save');
            }, delay);
        }));
        this.register(this.settings.onChange('autoSyncIntervalMinutes', () => this.restartInterval()));
        this.restartInterval();
        if (this.settings.get('autoSyncOnStart')) {
            setTimeout(() => void this.pullNow('startup'), 2500);
        }
    }
    onunload() {
        if (this.intervalTimer)
            clearInterval(this.intervalTimer);
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.settingTab = null;
    }
    getLastResult() {
        return this.lastResult;
    }
    getOperation() {
        return this.operation;
    }
    isBusy() {
        return this.operation !== null;
    }
    updateLastResult(result) {
        this.lastResult = result;
        this.settingTab?.refreshSyncStatus();
    }
    async testRepository() {
        const repoPath = this.getRepoPath();
        if (!repoPath)
            throw new Error('未设置 Git 仓库路径，且当前未打开笔记文件夹。');
        const inside = await this.runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
        const branch = (await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).stdout.trim();
        const remote = this.settings.get('remote') || 'origin';
        const remoteUrl = (await this.runGit(['remote', 'get-url', remote], repoPath)).stdout.trim();
        return { repoPath, branch, remote, remoteUrl, inside: inside.stdout.trim() };
    }
    async pullNow(trigger) {
        if (this.isBusy()) {
            if (trigger === 'manual')
                Notice.warning('Git 操作正在进行，请稍后再试。', this.settings.get('noticeDurationMs'));
            return;
        }
        this.operation = 'pull';
        const startedAt = new Date();
        this.updateLastResult(`${this.formatDateTime(startedAt)} · 拉取中…`);
        const repoPath = this.getRepoPath();
        if (!repoPath) {
            this.updateLastResult(`${this.formatDateTime(new Date())} · 拉取失败：未设置仓库路径`);
            this.operation = null;
            this.settingTab?.refreshSyncStatus();
            Notice.error('Git 拉取失败：未设置仓库路径。', this.settings.get('noticeDurationMs'));
            return;
        }
        if (trigger === 'manual')
            Notice.info('正在从 GitHub 拉取笔记…', 1500);
        try {
            await this.runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
            const branch = await this.resolveBranch(repoPath);
            const remote = (this.settings.get('remote') || 'origin').trim();
            const remoteBranchExists = await this.remoteBranchExists(repoPath, remote, branch);
            if (!remoteBranchExists) {
                const message = `远端分支 ${remote}/${branch} 不存在，已跳过拉取`;
                this.updateLastResult(`${this.formatDateTime(new Date())} · ${message}`);
                Notice.warning(message, this.settings.get('noticeDurationMs'));
                return;
            }
            const pull = await this.runGitAllowFailure(['pull', '--rebase', '--autostash', remote, branch], repoPath);
            if (pull.code !== 0) {
                await this.runGitAllowFailure(['rebase', '--abort'], repoPath);
                throw new Error(this.gitError('git pull --rebase', pull));
            }
            const output = `${pull.stdout}\n${pull.stderr}`;
            const noUpdates = /already up[ -]to[ -]date/i.test(output);
            const duration = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
            const resultText = noUpdates ? '远端无更新' : '拉取完成';
            this.updateLastResult(`${this.formatDateTime(new Date())} · ${resultText}`);
            this.refreshTyporaFilePanel();
            Notice.success(`${trigger === 'startup' ? '启动拉取' : 'Git 拉取'}完成：${resultText}（${duration}s）`, this.settings.get('noticeDurationMs'));
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.updateLastResult(`${this.formatDateTime(new Date())} · 拉取失败：${text}`);
            console.error('[Note Sync] pull', error);
            Notice.error(`Git 拉取失败：${text}`, Math.max(5000, this.settings.get('noticeDurationMs')));
        }
        finally {
            this.operation = null;
            this.settingTab?.refreshSyncStatus();
        }
    }
    async syncNow(trigger) {
        if (this.isBusy()) {
            if (trigger === 'manual')
                Notice.warning('Git 操作正在进行，请稍后再试。', this.settings.get('noticeDurationMs'));
            return;
        }
        this.operation = 'sync';
        const startedAt = new Date();
        this.updateLastResult(`${this.formatDateTime(startedAt)} · 提交并推送中…`);
        const repoPath = this.getRepoPath();
        if (!repoPath) {
            this.updateLastResult(`${this.formatDateTime(new Date())} · 同步失败：未设置仓库路径`);
            this.operation = null;
            this.settingTab?.refreshSyncStatus();
            Notice.error('Git 同步失败：未设置仓库路径。', this.settings.get('noticeDurationMs'));
            return;
        }
        if (trigger === 'manual')
            Notice.info('正在提交并推送笔记…', 1500);
        try {
            await this.runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
            const branch = await this.resolveBranch(repoPath);
            const remote = (this.settings.get('remote') || 'origin').trim();
            const status = await this.runGit(['status', '--porcelain'], repoPath);
            let committed = false;
            let changedFiles = 0;
            if (status.stdout.trim()) {
                changedFiles = status.stdout.trim().split(/\r?\n/).filter(Boolean).length;
                await this.runGit(['add', '-A'], repoPath);
                const staged = await this.runGit(['diff', '--cached', '--name-only'], repoPath);
                if (staged.stdout.trim()) {
                    const message = this.makeCommitMessage(branch, changedFiles);
                    await this.runGit(['commit', '-m', message], repoPath);
                    committed = true;
                }
            }
            const remoteBranchExists = await this.remoteBranchExists(repoPath, remote, branch);
            const pushArgs = remoteBranchExists
                ? ['push', remote, branch]
                : ['push', '-u', remote, branch];
            const push = await this.runGitAllowFailure(pushArgs, repoPath);
            if (push.code !== 0) {
                let message = this.gitError(`git ${pushArgs.join(' ')}`, push);
                if (/non-fast-forward|fetch first|rejected/i.test(`${push.stdout}\n${push.stderr}`)) {
                    message += '。远端存在较新的提交，请先执行“手动拉取”，然后再次同步。';
                }
                throw new Error(message);
            }
            const duration = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
            const parts = [
                committed ? `已提交 ${changedFiles} 个变更` : '本地无新变更',
                remoteBranchExists ? '已推送' : '已创建远端分支并推送',
            ];
            this.updateLastResult(`${this.formatDateTime(new Date())} · ${parts.join(' · ')}`);
            this.refreshTyporaFilePanel();
            Notice.success(`Git 同步完成：${parts.join('，')}（${duration}s）`, this.settings.get('noticeDurationMs'));
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.updateLastResult(`${this.formatDateTime(new Date())} · 同步失败：${text}`);
            console.error('[Note Sync] sync', error);
            Notice.error(`Git 同步失败：${text}`, Math.max(5000, this.settings.get('noticeDurationMs')));
        }
        finally {
            this.operation = null;
            this.settingTab?.refreshSyncStatus();
        }
    }
    refreshTyporaFilePanel() {
        try {
            editor?.library?.refreshPanelCommand?.();
        }
        catch (error) {
            console.warn('[Note Sync] 刷新 Typora 文件面板失败', error);
        }
    }
    restartInterval() {
        if (this.intervalTimer) {
            clearInterval(this.intervalTimer);
            this.intervalTimer = null;
        }
        const minutes = Number(this.settings.get('autoSyncIntervalMinutes')) || 0;
        if (minutes <= 0)
            return;
        this.intervalTimer = setInterval(() => void this.syncNow('interval'), Math.max(1, minutes) * 60_000);
    }
    getRepoPath() {
        const configured = (this.settings.get('repoPath') || '').trim();
        if (configured)
            return configured;
        return (this.app.vault?.path || '').trim();
    }
    async resolveBranch(repoPath) {
        const configured = (this.settings.get('branch') || '').trim();
        if (configured)
            return configured;
        const result = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
        const branch = result.stdout.trim();
        if (!branch || branch === 'HEAD')
            throw new Error('当前仓库处于 detached HEAD，请在设置中指定分支。');
        return branch;
    }
    makeCommitMessage(branch, files) {
        const now = new Date();
        const date = this.formatDate(now);
        const time = this.formatTime(now);
        const datetime = `${date} ${time}`;
        if (this.settings.get('commitMode') === 'timestamp') {
            const prefix = (this.settings.get('timestampPrefix') || 'sync').trim();
            return `${prefix}: ${datetime}`;
        }
        const template = (this.settings.get('commitTemplate') || 'sync: {datetime}').trim();
        return template
            .replaceAll('{date}', date)
            .replaceAll('{time}', time)
            .replaceAll('{datetime}', datetime)
            .replaceAll('{branch}', branch)
            .replaceAll('{files}', String(files));
    }
    async remoteBranchExists(repoPath, remote, branch) {
        const result = await this.runGitAllowFailure(['ls-remote', '--exit-code', '--heads', remote, branch], repoPath);
        if (result.code === 0)
            return true;
        if (result.code === 2)
            return false;
        throw new Error(this.gitError('git ls-remote', result));
    }
    async runGit(args, cwd) {
        const result = await this.runGitAllowFailure(args, cwd);
        if (result.code !== 0)
            throw new Error(this.gitError(`git ${args.join(' ')}`, result));
        return result;
    }
    runGitAllowFailure(args, cwd) {
        return new Promise((resolve, reject) => {
            const executable = (this.settings.get('gitExecutable') || 'git').trim();
            const child = spawn(executable, args, {
                cwd,
                windowsHide: true,
                shell: false,
                env: processEnv,
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });
    }
    gitError(command, result) {
        const detail = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
        return `${command}：${detail}`;
    }
    pad(value) {
        return String(value).padStart(2, '0');
    }
    formatDate(date) {
        return `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}-${this.pad(date.getDate())}`;
    }
    formatTime(date) {
        return `${this.pad(date.getHours())}:${this.pad(date.getMinutes())}:${this.pad(date.getSeconds())}`;
    }
    formatDateTime(date) {
        return `${this.formatDate(date)} ${this.formatTime(date)}`;
    }
}
class NoteSyncSettingTab extends SettingTab {
    get name() {
        return 'Note Sync';
    }
    constructor(plugin) {
        super();
        this.plugin = plugin;
        this.statusDescriptionEl = null;
        this.pullButtonEl = null;
        this.syncButtonEl = null;
        this.visible = false;
    }
    onshow() {
        this.visible = true;
        this.render();
    }
    onhide() {
        this.visible = false;
        this.statusDescriptionEl = null;
        this.pullButtonEl = null;
        this.syncButtonEl = null;
    }
    refreshSyncStatus() {
        if (!this.visible)
            return;
        if (this.statusDescriptionEl) {
            this.statusDescriptionEl.textContent = this.plugin.getLastResult();
        }
        const operation = this.plugin.getOperation();
        const busy = this.plugin.isBusy();
        if (this.pullButtonEl) {
            this.pullButtonEl.disabled = busy;
            this.pullButtonEl.textContent = operation === 'pull' ? '拉取中…' : '手动拉取';
        }
        if (this.syncButtonEl) {
            this.syncButtonEl.disabled = busy;
            this.syncButtonEl.textContent = operation === 'sync' ? '同步中…' : '立即同步';
        }
    }
    render() {
        this.statusDescriptionEl = null;
        this.pullButtonEl = null;
        this.syncButtonEl = null;
        this.containerEl.innerHTML = '';
        this.addSettingTitle('Git 仓库');
        this.addSetting((setting) => {
            setting.addName('仓库路径');
            setting.addDescription('Git 仓库根目录。留空时使用当前 Typora 笔记文件夹。');
            setting.addText(input => {
                input.placeholder = '例如 E:\\Obsidian\\MyObsidian';
                input.value = this.plugin.settings.get('repoPath') || '';
                input.onchange = () => this.plugin.settings.set('repoPath', input.value.trim());
            });
        });
        this.addSetting((setting) => {
            setting.addName('Git 可执行文件');
            setting.addDescription('通常保持 git；若 Git 未加入 PATH，可填写 git.exe 的完整路径。');
            setting.addText(input => {
                input.value = this.plugin.settings.get('gitExecutable') || 'git';
                input.onchange = () => this.plugin.settings.set('gitExecutable', input.value.trim() || 'git');
            });
        });
        this.addSetting((setting) => {
            setting.addName('远程仓库');
            setting.addText(input => {
                input.value = this.plugin.settings.get('remote') || 'origin';
                input.onchange = () => this.plugin.settings.set('remote', input.value.trim() || 'origin');
            });
        });
        this.addSetting((setting) => {
            setting.addName('分支');
            setting.addDescription('留空时自动使用当前 Git 分支。');
            setting.addText(input => {
                input.placeholder = 'main';
                input.value = this.plugin.settings.get('branch') || '';
                input.onchange = () => this.plugin.settings.set('branch', input.value.trim());
            });
        });
        this.addSetting((setting) => {
            setting.addName('测试仓库');
            setting.addDescription('检查路径、当前分支和远程仓库 URL。');
            setting.addButton(button => {
                button.textContent = '测试';
                button.onclick = async () => {
                    button.disabled = true;
                    try {
                        const info = await this.plugin.testRepository();
                        Notice.success(`仓库正常：${info.branch} → ${info.remote} (${info.remoteUrl})`, 5000);
                    }
                    catch (error) {
                        Notice.error(`仓库检查失败：${error instanceof Error ? error.message : String(error)}`, 6000);
                    }
                    finally {
                        button.disabled = false;
                    }
                };
            });
        });
        this.addSettingTitle('Commit');
        this.addSetting((setting) => {
            setting.addName('Commit 模式');
            setting.addDescription('时间戳模式自动生成；自定义模式支持模板占位符。');
            setting.addSelect({
                options: ['timestamp', 'custom'],
                selected: this.plugin.settings.get('commitMode'),
                onchange: event => {
                    this.plugin.settings.set('commitMode', event.target.value);
                    this.render();
                },
            });
        });
        if (this.plugin.settings.get('commitMode') === 'timestamp') {
            this.addSetting((setting) => {
                setting.addName('时间戳前缀');
                setting.addDescription('示例：sync: 2026-09-10 20:30:00');
                setting.addText(input => {
                    input.value = this.plugin.settings.get('timestampPrefix') || 'sync';
                    input.onchange = () => this.plugin.settings.set('timestampPrefix', input.value.trim() || 'sync');
                });
            });
        }
        else {
            this.addSetting((setting) => {
                setting.addName('Commit 模板');
                setting.addDescription('支持 {date}、{time}、{datetime}、{branch}、{files}。');
                setting.addText(input => {
                    input.placeholder = 'notes: {datetime} ({files} files)';
                    input.value = this.plugin.settings.get('commitTemplate') || 'sync: {datetime}';
                    input.onchange = () => this.plugin.settings.set('commitTemplate', input.value || 'sync: {datetime}');
                });
            });
        }
        this.addSettingTitle('自动操作');
        this.addSetting((setting) => {
            setting.addName('启动时拉取');
            setting.addDescription('Typora 启动约 2.5 秒后仅执行 git pull --rebase --autostash，不提交、不 push。');
            setting.addCheckbox(input => {
                input.checked = this.plugin.settings.get('autoSyncOnStart');
                input.onchange = () => this.plugin.settings.set('autoSyncOnStart', input.checked);
            });
        });
        this.addSetting((setting) => {
            setting.addName('保存后提交并推送');
            setting.addDescription('检测到保存后延迟执行 add → commit → push；不会自动 pull。');
            setting.addCheckbox(input => {
                input.checked = this.plugin.settings.get('autoSyncOnSave');
                input.onchange = () => this.plugin.settings.set('autoSyncOnSave', input.checked);
            });
        });
        this.addSetting((setting) => {
            setting.addName('保存后延迟（秒）');
            setting.addInput('number', input => {
                input.min = '1';
                input.step = '1';
                input.value = String(this.plugin.settings.get('saveSyncDelaySeconds') || 5);
                input.onchange = () => this.plugin.settings.set('saveSyncDelaySeconds', Math.max(1, Number(input.value) || 5));
            });
        });
        this.addSetting((setting) => {
            setting.addName('定时提交并推送（分钟）');
            setting.addDescription('0 表示关闭；定时任务只执行 add → commit → push，不会自动 pull。');
            setting.addInput('number', input => {
                input.min = '0';
                input.step = '1';
                input.value = String(this.plugin.settings.get('autoSyncIntervalMinutes') || 0);
                input.onchange = () => this.plugin.settings.set('autoSyncIntervalMinutes', Math.max(0, Number(input.value) || 0));
            });
        });
        this.addSettingTitle('操作与状态');
        this.addSetting((setting) => {
            setting.addName('手动操作');
            setting.addDescription('“手动拉取”只 pull；“立即同步”只执行 add → commit → push。');
            setting.addButton(button => {
                this.pullButtonEl = button;
                button.textContent = '手动拉取';
                button.onclick = () => void this.plugin.pullNow('manual');
            });
            setting.addButton(button => {
                this.syncButtonEl = button;
                button.textContent = '立即同步';
                button.onclick = () => void this.plugin.syncNow('manual');
            });
        });
        this.addSetting((setting) => {
            setting.addName('最近操作');
            setting.addDescription(div => {
                this.statusDescriptionEl = div;
                div.textContent = this.plugin.getLastResult();
            });
        });
        this.addSettingTitle('界面');
        this.addSetting((setting) => {
            setting.addName('通知显示时间（毫秒）');
            setting.addInput('number', input => {
                input.min = '1000';
                input.step = '500';
                input.value = String(this.plugin.settings.get('noticeDurationMs') || 3000);
                input.onchange = () => this.plugin.settings.set('noticeDurationMs', Math.max(1000, Number(input.value) || 3000));
            });
        });
        this.refreshSyncStatus();
    }
}
