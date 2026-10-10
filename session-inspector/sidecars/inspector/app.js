const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let currentData = null;
let viewMode = 'total'; // 'total' | 'latest'
let sessionStartTime = null;
let timerInterval = null;
let pollTimeout = null;
let isFetching = false;
let activeConversationId = null;
let isCopying = false;

// Number formatting helpers
function formatTokenVal(num) {
  if (num === undefined || num === null) return '0';
  const n = Number(num);
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return String(n);
}

function formatWithCommas(num) {
  if (num === undefined || num === null) return '0';
  return Number(num).toLocaleString('en-US');
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '00:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Robust clipboard copy helper with native macOS pbcopy guarantee
async function copyToClipboard(text) {
  if (!text) return false;
  let success = false;

  // 1. Native macOS clipboard via sidecar backend (guaranteed to work in Electron iframes)
  if (sidecar && sidecar.fetch) {
    try {
      const res = await sidecar.fetch('/api/copy', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data && data.ok) success = true;
    } catch (err) {
      console.warn('Backend copy endpoint failed:', err);
    }
  }

  // 2. Modern navigator.clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      // Fallback
    }
  }

  // 3. Fallback: document.execCommand('copy') via temporary textarea
  if (!success) {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      success = document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch {
      // Fallback
    }
  }

  return success;
}

// Fetch stats from backend with in-flight lock and chain polling
async function fetchData(isManual = false) {
  if (!sidecar || isFetching) return;
  isFetching = true;

  const btn = $('btn-refresh');
  if (isManual && btn) btn.classList.add('is-loading');

  try {
    const conversationId = sidecar.conversationId || null;
    let workspaceUri = null;
    if (sidecar.getWorkspaceUris) {
      const uris = await sidecar.getWorkspaceUris().catch(() => []);
      if (uris && uris.length > 0) {
        workspaceUri = uris[0];
      }
    }

    const res = await sidecar.fetch('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        workspacePath: workspaceUri,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    currentData = data;
    render();
  } catch (err) {
    console.error('[inspector] Failed to fetch inspection data:', err);
  } finally {
    isFetching = false;
    if (btn) btn.classList.remove('is-loading');
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (pollTimeout) clearTimeout(pollTimeout);
  if (document.hidden) return; // Pause when tab is in background
  pollTimeout = setTimeout(() => {
    fetchData(false);
  }, 3000);
}

// Render data into the DOM
function render() {
  if (!currentData) return;

  const conv = currentData.conversation;
  const git = currentData.git;

  // 1. Git rendering is fully decoupled from conversation existence
  renderGit(git);

  // 2. If no conversation data yet, display clean empty state
  if (!conv) {
    $('token-banner-text').textContent = '等待当前会话输入...';
    $('token-banner-desc').textContent = '会话启动后将自动显示 Token 消耗与速度';
    return;
  }

  // 3. Model & Session Info
  const mName = conv.modelName || 'Gemini Flash';
  const modelLimit = conv.contextWindow?.limitFormatted || '1M';
  $('model-badge').textContent = `${mName} · ${modelLimit}`;
  $('model-badge').title = `${mName} (上下文上限 ${modelLimit})`;
  $('steps-badge').textContent = `${conv.totalSteps || 0} 步骤 (${conv.totalUserTurns || 0} 轮交互)`;

  activeConversationId = conv.conversationId;
  const convIdBadge = $('conv-id-badge');
  if (activeConversationId) {
    convIdBadge.textContent = activeConversationId;
    convIdBadge.title = '点击复制完整 ID: ' + activeConversationId;
  } else {
    convIdBadge.textContent = '未绑定';
  }

  // 4. Start time & Timer
  if (conv.startTime) {
    sessionStartTime = new Date(conv.startTime).getTime();
    updateTimer();
  }

  // 5. Token speed
  const speedVal = conv.speed?.latest || conv.speed?.average || 0;
  $('stat-speed').textContent = `${speedVal} tok/s`;

  // 6. Token Consumption Cards (Requirement 7 & 3)
  const tokData = (viewMode === 'total' ? conv.tokens?.total : conv.tokens?.latest) || {
    sum: 0,
    in: 0,
    out: 0,
    cache: 0,
    cacheHitRate: 0,
  };

  const inStr = formatTokenVal(tokData.in);
  const outStr = formatTokenVal(tokData.out);
  const cacheStr = formatTokenVal(tokData.cache);
  const sumStr = formatTokenVal(tokData.sum);

  // Exact requested format: Tokens 4.2M (in: 48, out: 61k, cache: 4.1M)
  $('token-banner-text').textContent = `Tokens ${sumStr} (in: ${inStr}, out: ${outStr}, cache: ${cacheStr})`;

  // Accurate context window utilization
  const activeCtx = conv.contextWindow?.used || conv.currentContextTokens || 0;
  const ctxPct = ((activeCtx / 1000000) * 100).toFixed(1);
  $('token-banner-desc').textContent = (viewMode === 'total')
    ? `当前窗口上下文占百万容量约 ${ctxPct}% (累计总消耗 ${formatWithCommas(tokData.sum)} tokens)`
    : `最近单轮消耗 ${formatWithCommas(tokData.sum)} tokens (当前上下文占百万容量约 ${ctxPct}%)`;

  $('val-input').textContent = formatWithCommas(tokData.in);
  $('val-output').textContent = formatWithCommas(tokData.out);
  $('val-cache').textContent = formatWithCommas(tokData.cache);

  // Cache hit rate (Requirement 3)
  const hitRate = tokData.cacheHitRate || 0;
  $('cache-rate-text').textContent = `${hitRate}%`;
  $('cache-bar-fill').style.width = `${Math.min(hitRate, 100)}%`;

  // 7. Context Window Breakdown
  renderContextWindow(conv.contextWindow);

  // 8. Tools invoked (Requirement 4)
  renderTools(conv);

  // 9. Skills & MCP (Requirement 5 & 6)
  renderSkillsAndMcp(conv);

  // 10. Artifacts list (Requirement 9)
  renderArtifacts(conv);
}

let currentGitFilter = 'all'; // 'all' | 'staged' | 'modified' | 'untracked' | 'conflict'
let cachedGitData = null;

function setGitFilter(filter) {
  if (currentGitFilter === filter) {
    currentGitFilter = 'all'; // Toggle back to all
  } else {
    currentGitFilter = filter;
  }
  if (cachedGitData) {
    renderGit(cachedGitData);
  }
}

function renderGit(git) {
  cachedGitData = git;
  const badge = $('git-status-badge');
  const statsRow = $('git-stats-row');

  if (!git || !git.isGit) {
    badge.textContent = '非 Git 仓库';
    badge.className = 'badge';
    if (statsRow) statsRow.style.display = 'none';
    $('git-branch').textContent = '未关联仓库';
    $('git-worktree').textContent = '无';
    if ($('git-diff-summary')) $('git-diff-summary').textContent = '';
    $('git-file-list').innerHTML = '<div style="color: var(--text-muted); padding: 4px;">当前工程目录不是 Git 代码库</div>';
    return;
  }

  badge.textContent = '已连接';
  badge.className = 'badge success';
  if (statsRow) statsRow.style.display = 'flex';

  $('git-branch').textContent = git.branch || 'HEAD';
  $('git-worktree').textContent = git.currentWorktree || 'main';

  const total = git.totalChanges || 0;
  const staged = git.stagedCount || 0;
  const modified = git.modifiedCount || 0;
  const untracked = git.untrackedCount || 0;
  const conflict = git.conflictCount || 0;

  // Fallback to 'all' if active filter category has 0 files
  if (
    (currentGitFilter === 'staged' && staged === 0) ||
    (currentGitFilter === 'modified' && modified === 0) ||
    (currentGitFilter === 'untracked' && untracked === 0) ||
    (currentGitFilter === 'conflict' && conflict === 0)
  ) {
    currentGitFilter = 'all';
  }

  // Update filter buttons
  const btnAll = $('stat-all');
  const btnStaged = $('stat-staged');
  const btnModified = $('stat-modified');
  const btnUntracked = $('stat-untracked');

  if (btnAll) {
    btnAll.textContent = `全部 ${total}`;
    btnAll.classList.toggle('active', currentGitFilter === 'all');
    btnAll.classList.toggle('disabled', total === 0);
  }

  if (btnStaged) {
    btnStaged.textContent = `暂存 ${staged}`;
    btnStaged.classList.toggle('active', currentGitFilter === 'staged');
    btnStaged.classList.toggle('disabled', staged === 0);
  }

  if (btnModified) {
    btnModified.textContent = `修改 ${modified}`;
    btnModified.classList.toggle('active', currentGitFilter === 'modified');
    btnModified.classList.toggle('disabled', modified === 0);
  }

  if (btnUntracked) {
    btnUntracked.textContent = `未跟踪 ${untracked}`;
    btnUntracked.classList.toggle('active', currentGitFilter === 'untracked');
    btnUntracked.classList.toggle('disabled', untracked === 0);
  }

  // Conflict badge
  let confEl = $('stat-conflict');
  if (conflict > 0) {
    if (!confEl) {
      confEl = document.createElement('button');
      confEl.type = 'button';
      confEl.id = 'stat-conflict';
      confEl.className = 'git-stat-badge stat-conflict';
      confEl.title = '只看冲突文件';
      confEl.addEventListener('click', () => setGitFilter('conflict'));
      statsRow.appendChild(confEl);
    }
    confEl.textContent = `冲突 ${conflict}`;
    confEl.classList.toggle('active', currentGitFilter === 'conflict');
    confEl.classList.toggle('disabled', false);
    confEl.style.display = 'inline-flex';
  } else if (confEl) {
    confEl.style.display = 'none';
  }

  $('git-diff-summary').textContent = git.diffStat || '';

  // Filter files
  const allFiles = git.changedFiles || [];
  let displayFiles = allFiles;

  if (currentGitFilter === 'staged') {
    displayFiles = allFiles.filter(f => f.isStaged);
  } else if (currentGitFilter === 'modified') {
    displayFiles = allFiles.filter(f => f.isModified);
  } else if (currentGitFilter === 'untracked') {
    displayFiles = allFiles.filter(f => f.isUntracked);
  } else if (currentGitFilter === 'conflict') {
    displayFiles = allFiles.filter(f => f.isConflict);
  }

  // Preserve scroll position
  const listEl = $('git-file-list');
  const prevScrollTop = listEl.scrollTop;

  if (allFiles.length === 0) {
    listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; padding: 4px;">工作区干净，无未提交更改</div>';
  } else if (displayFiles.length === 0) {
    const filterNames = {
      staged: '暂存',
      modified: '修改',
      untracked: '未跟踪',
      conflict: '冲突',
    };
    const name = filterNames[currentGitFilter] || '该分类';
    listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 11px; padding: 4px;">暂无${name}的文件</div>`;
  } else {
    listEl.innerHTML = displayFiles.map((f) => {
      let statusClass = 'color: var(--text-main)';
      if (f.status.includes('M')) statusClass = 'color: var(--color-warning)';
      if (f.status.includes('A') || f.status === '??') statusClass = 'color: var(--color-success)';
      if (f.status.includes('D') || f.status.includes('U')) statusClass = 'color: var(--color-danger)';
      return `<div class="file-row">
        <span class="file-status" style="${statusClass}">${f.status}</span>
        <span class="file-name" title="${f.file}">${f.file}</span>
      </div>`;
    }).join('');
    listEl.scrollTop = prevScrollTop;
  }
}

function renderContextWindow(cw) {
  const card = $('card-context-window');
  if (!card) return;
  if (!cw) {
    $('ctx-summary-text').textContent = '-- / 1M (0%)';
    return;
  }

  const { limitFormatted, used, usedPercent, breakdown, compaction } = cw;
  $('ctx-summary-text').textContent = `${formatTokenVal(used)} / ${limitFormatted || '1M'} (${usedPercent}%)`;

  // Dynamic health status indicator
  const healthBadge = $('ctx-health-badge');
  if (healthBadge) {
    if (usedPercent >= 85) {
      healthBadge.className = 'ctx-health-badge danger';
      healthBadge.textContent = '紧张';
      healthBadge.title = `上下文使用率 ${usedPercent}%，已接近缓冲区警戒线`;
    } else if (usedPercent >= 70) {
      healthBadge.className = 'ctx-health-badge warning';
      healthBadge.textContent = '注意';
      healthBadge.title = `上下文使用率 ${usedPercent}%，建议适时精简提示词或提交阶段改动`;
    } else {
      healthBadge.className = 'ctx-health-badge healthy';
      healthBadge.textContent = '健康';
      healthBadge.title = `上下文使用率 ${usedPercent}%，容量充裕`;
    }
  }

  // Compaction and Retained Turns Status
  const compVal = $('ctx-compaction-val');
  const turnsVal = $('ctx-retained-turns-val');
  if (compaction && compVal && turnsVal) {
    if (compaction.isCompacted) {
      compVal.className = 'compaction-val compacted';
      compVal.textContent = `⚠️ 已压缩 ${compaction.count} 次 (早期细节已浓缩)`;
      compVal.title = `系统此前已对长会话进行过 ${compaction.count} 次自动上下文压缩/截断，早期历史已提炼为摘要`;
      turnsVal.textContent = `保留近 ${compaction.retainedTurns} 轮 / 累计 ${compaction.totalTurns} 轮`;
      turnsVal.title = `当前上下文窗口内完整保留了最近 ${compaction.retainedTurns} 轮交互细节，整场会话累计 ${compaction.totalTurns} 轮交互`;
    } else {
      compVal.className = 'compaction-val';
      compVal.textContent = '✅ 未压缩 (完整历史)';
      compVal.title = '当前会话未发生过任何截断，所有历史对话与工具执行结果均在上下文窗口内';
      turnsVal.textContent = `完整 ${compaction.totalTurns || 0} 轮交互`;
      turnsVal.title = `整场会话共 ${compaction.totalTurns || 0} 轮交互，全部在当前上下文窗口中完整保留`;
    }
  }

  if (!breakdown) return;

  // Segment widths
  $('seg-messages').style.width = `${breakdown.messages?.percent || 0}%`;
  $('seg-system-tools').style.width = `${breakdown.systemTools?.percent || 0}%`;
  $('seg-memory').style.width = `${breakdown.memory?.percent || 0}%`;
  $('seg-mcp').style.width = `${breakdown.mcpTools?.percent || 0}%`;
  $('seg-skills').style.width = `${breakdown.skills?.percent || 0}%`;
  $('seg-prompt').style.width = `${breakdown.systemPrompt?.percent || 0}%`;
  $('seg-autocompact').style.width = `${breakdown.autocompactBuffer?.percent || 0}%`;

  // Item values & percentages
  $('ctx-val-messages').textContent = formatTokenVal(breakdown.messages?.tokens || 0);
  $('ctx-pct-messages').textContent = `${breakdown.messages?.percent || 0}%`;

  $('ctx-val-systools').textContent = formatTokenVal(breakdown.systemTools?.tokens || 0);
  $('ctx-pct-systools').textContent = `${breakdown.systemTools?.percent || 0}%`;

  $('ctx-val-memory').textContent = formatTokenVal(breakdown.memory?.tokens || 0);
  $('ctx-pct-memory').textContent = `${breakdown.memory?.percent || 0}%`;

  $('ctx-val-mcp').textContent = formatTokenVal(breakdown.mcpTools?.tokens || 0);
  $('ctx-pct-mcp').textContent = `${breakdown.mcpTools?.percent || 0}%`;

  $('ctx-val-skills').textContent = formatTokenVal(breakdown.skills?.tokens || 0);
  $('ctx-pct-skills').textContent = `${breakdown.skills?.percent || 0}%`;

  $('ctx-val-prompt').textContent = formatTokenVal(breakdown.systemPrompt?.tokens || 0);
  $('ctx-pct-prompt').textContent = `${breakdown.systemPrompt?.percent || 0}%`;

  $('ctx-val-autocompact').textContent = formatTokenVal(breakdown.autocompactBuffer?.tokens || 0);
  $('ctx-pct-autocompact').textContent = `${breakdown.autocompactBuffer?.percent || 0}%`;

  $('ctx-val-free').textContent = formatTokenVal(breakdown.freeSpace?.tokens || 0);
  $('ctx-pct-free').textContent = `${breakdown.freeSpace?.percent || 0}%`;

  // Memory files accordion
  const memFiles = breakdown.memory?.files || [];
  $('ctx-summary-memory-meta').textContent = `${memFiles.length} 个 (~${formatTokenVal(breakdown.memory?.tokens || 0)})`;

  const listEl = $('ctx-list-memory');
  if (listEl) {
    if (memFiles.length === 0) {
      listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 10px;">暂无记忆文件</span>';
    } else {
      listEl.innerHTML = memFiles.map((f) => `
        <div class="ctx-sub-file">
          <span title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span>~${formatTokenVal(f.tokens)}</span>
        </div>
      `).join('');
    }
  }
}

function renderTools(conv) {
  const toolCounts = conv.toolCounts || {};
  const toolKeys = Object.keys(toolCounts);
  const totalCalls = toolKeys.reduce((sum, k) => sum + toolCounts[k], 0);

  $('tool-total-badge').textContent = `${totalCalls} 次调用`;

  const tagsEl = $('tool-tags');
  if (toolKeys.length === 0) {
    tagsEl.innerHTML = '<span style="font-size: 11px; color: var(--text-muted);">暂无工具调用</span>';
  } else {
    tagsEl.innerHTML = toolKeys.map((k) => `
      <div class="tag-pill">
        <span>${k}</span>
        <span class="count">${toolCounts[k]}</span>
      </div>
    `).join('');
  }

  const recentEl = $('recent-tools');
  const prevScroll = recentEl.scrollTop;
  if (conv.recentTools && conv.recentTools.length > 0) {
    recentEl.innerHTML = conv.recentTools.map((t) => `
      <div class="tool-row">
        <span class="tool-name">${t.name}</span>
        <span class="tool-summary" title="${t.summary || t.action}">${t.summary || t.action}</span>
      </div>
    `).join('');
    recentEl.scrollTop = prevScroll;
  } else {
    recentEl.innerHTML = '';
  }
}

function renderSkillsAndMcp(conv) {
  const skills = conv.skillsUsed || [];
  const skillsEl = $('skills-cloud');
  if (skills.length === 0) {
    skillsEl.innerHTML = '<span style="font-size: 11px; color: var(--text-muted);">未触发任何 Skill</span>';
  } else {
    skillsEl.innerHTML = skills.map((s) => `
      <div class="tag-pill" style="border-color: color-mix(in srgb, var(--primary-color) 40%, transparent); background: color-mix(in srgb, var(--primary-color) 12%, transparent);">
        <span>⚡ ${s}</span>
      </div>
    `).join('');
  }

  const mcps = conv.mcpsUsed || [];
  const mcpEl = $('mcp-cloud');
  if (mcps.length === 0) {
    mcpEl.innerHTML = '<span style="font-size: 11px; color: var(--text-muted);">暂无外部 MCP 调用</span>';
  } else {
    mcpEl.innerHTML = mcps.map((m) => `
      <div class="tag-pill" style="border-color: color-mix(in srgb, #a855f7 40%, transparent); background: color-mix(in srgb, #a855f7 12%, transparent);">
        <span>🔌 ${m}</span>
      </div>
    `).join('');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getArtifactIcon(a) {
  if (a.isImage) return '🖼️';
  if (a.isMarkdown) return '📝';
  if (/\.(json|js|ts|html|css|py|sh|yaml|yml)$/i.test(a.name)) return '📄';
  return '📦';
}

let currentModalArtifact = null;

function closeImageModal() {
  const modal = $('image-modal');
  if (modal) modal.style.display = 'none';
  const imgEl = $('modal-img-preview');
  if (imgEl) {
    imgEl.src = '';
    imgEl.style.display = 'none';
  }
  currentModalArtifact = null;
}

async function openImageModal(artifact) {
  if (!artifact) return;
  currentModalArtifact = artifact;

  const modal = $('image-modal');
  const nameEl = $('modal-img-name');
  const sizeEl = $('modal-img-size');
  const loadingEl = $('modal-img-loading');
  const imgEl = $('modal-img-preview');
  const btnOpenSys = $('modal-btn-open-sys');
  const btnCopy = $('modal-btn-copy');

  if (!modal) return;

  nameEl.textContent = artifact.name || '图片预览';
  nameEl.title = artifact.path || '';
  const sizeKB = Math.round((artifact.size || 0) / 1024);
  sizeEl.textContent = `${sizeKB} KB`;

  imgEl.src = '';
  imgEl.style.display = 'none';
  loadingEl.style.display = 'block';
  loadingEl.textContent = '加载图片中...';
  modal.style.display = 'flex';

  // Wire buttons for current artifact
  btnOpenSys.onclick = async () => {
    btnOpenSys.style.opacity = '0.6';
    try {
      await sidecar.fetch('/api/open-artifact', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: activeConversationId,
          path: artifact.path,
        }),
      });
    } catch (err) {
      console.warn('Failed to open image in system:', err);
    } finally {
      setTimeout(() => { btnOpenSys.style.opacity = '1'; }, 300);
    }
  };

  btnCopy.onclick = async () => {
    const origHtml = btnCopy.innerHTML;
    try {
      const ok = await copyToClipboard(artifact.path);
      if (ok) {
        btnCopy.innerHTML = '<span>已复制!</span>';
        setTimeout(() => { btnCopy.innerHTML = origHtml; }, 1200);
      }
    } catch (err) {
      console.warn('Failed to copy image path:', err);
    }
  };

  try {
    const res = await sidecar.fetch('/api/image-data', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: activeConversationId,
        path: artifact.path,
      }),
    });
    const data = await res.json();
    if (data.ok && data.dataUrl) {
      imgEl.onload = () => {
        loadingEl.style.display = 'none';
        imgEl.style.display = 'block';
      };
      imgEl.onerror = () => {
        loadingEl.textContent = '图片渲染失败';
      };
      imgEl.src = data.dataUrl;
    } else {
      loadingEl.textContent = data.error || '图片读取失败';
    }
  } catch (err) {
    loadingEl.textContent = '网络请求失败';
  }
}

function renderArtifacts(conv) {
  const artifacts = conv.artifacts || [];
  const el = $('artifacts-list');
  if (artifacts.length === 0) {
    el.innerHTML = '<span style="color: var(--text-muted); font-size: 11px;">暂无生成的文件工件</span>';
    return;
  }

  el.innerHTML = artifacts.map((a, idx) => {
    const icon = getArtifactIcon(a);
    const sizeKB = Math.round((a.size || 0) / 1024);
    const summary = a.summary ? `<span style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">(${escapeHtml(a.summary)})</span>` : '';
    const clickTitle = a.isImage ? `点击在看板内查看预览: ${escapeHtml(a.name)}` : `点击使用系统默认程序打开: ${escapeHtml(a.path)}`;
    return `
      <div class="artifact-item" data-index="${idx}" title="${clickTitle}">
        <div class="artifact-info">
          <span class="artifact-icon">${icon}</span>
          <span class="artifact-name">${escapeHtml(a.name)}${summary}</span>
        </div>
        <div class="artifact-meta">
          <span class="artifact-size">${sizeKB} KB</span>
          <button class="btn-copy-path" data-path="${escapeHtml(a.path)}" title="复制文件完整路径">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>路径</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers to card rows
  const items = el.querySelectorAll('.artifact-item');
  items.forEach((item) => {
    item.addEventListener('click', async () => {
      const idx = Number(item.dataset.index);
      const artifact = artifacts[idx];
      if (!artifact) return;

      if (artifact.isImage) {
        openImageModal(artifact);
        return;
      }

      item.style.opacity = '0.6';
      try {
        await sidecar.fetch('/api/open-artifact', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: activeConversationId,
            path: artifact.path,
          }),
        });
      } catch (err) {
        console.warn('Failed to open artifact in system:', err);
      } finally {
        setTimeout(() => { item.style.opacity = '1'; }, 300);
      }
    });
  });

  // Attach copy path events
  const copyBtns = el.querySelectorAll('.btn-copy-path');
  copyBtns.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // Do not trigger item open or modal
      const path = btn.dataset.path;
      if (!path) return;

      const origHtml = btn.innerHTML;
      try {
        const ok = await copyToClipboard(path);
        if (ok) {
          btn.classList.add('copied');
          btn.innerHTML = '<span>已复制!</span>';
          setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = origHtml;
          }, 1200);
        }
      } catch (err) {
        console.warn('Failed to copy path:', err);
      }
    });
  });
}

function updateTimer() {
  if (!sessionStartTime) return;
  const now = Date.now();
  const elapsedSec = Math.floor((now - sessionStartTime) / 1000);
  $('stat-elapsed').textContent = formatDuration(elapsedSec);
}

function init() {
  // Toggle buttons
  $('toggle-total').addEventListener('click', () => {
    viewMode = 'total';
    $('toggle-total').classList.add('active');
    $('toggle-latest').classList.remove('active');
    render();
  });

  $('toggle-latest').addEventListener('click', () => {
    viewMode = 'latest';
    $('toggle-latest').classList.add('active');
    $('toggle-total').classList.remove('active');
    render();
  });

  // Refresh button
  $('btn-refresh').addEventListener('click', () => {
    fetchData(true);
  });

  // Context Window Header Toggle
  const ctxHeader = $('context-header');
  if (ctxHeader) {
    ctxHeader.addEventListener('click', () => {
      const list = $('ctx-breakdown-list');
      const compBar = $('ctx-compaction-bar');
      const accordions = document.querySelector('.ctx-sub-accordions');
      const arrow = $('ctx-toggle-arrow');
      if (list) list.classList.toggle('collapsed');
      if (compBar) compBar.classList.toggle('collapsed');
      if (accordions) accordions.classList.toggle('collapsed');
      if (arrow) arrow.classList.toggle('collapsed');
    });
  }

  // Copy Conversation ID with safe memory variable and lock
  $('conv-id-badge').addEventListener('click', async () => {
    if (isCopying || !activeConversationId) return;
    isCopying = true;
    try {
      const ok = await copyToClipboard(activeConversationId);
      if (ok) {
        const original = activeConversationId;
        $('conv-id-badge').textContent = '已复制!';
        setTimeout(() => {
          $('conv-id-badge').textContent = original;
          isCopying = false;
        }, 1500);
      } else {
        isCopying = false;
      }
    } catch (err) {
      console.warn('Clipboard write failed:', err);
      isCopying = false;
    }
  });

  // Image Lightbox Close Events
  const backdrop = $('image-modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeImageModal);

  const btnClose = $('modal-btn-close');
  if (btnClose) btnClose.addEventListener('click', closeImageModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = $('image-modal');
      if (modal && modal.style.display !== 'none') {
        closeImageModal();
      }
    }
  });

  // Git filter category click listeners
  $('stat-all')?.addEventListener('click', () => setGitFilter('all'));
  $('stat-staged')?.addEventListener('click', () => setGitFilter('staged'));
  $('stat-modified')?.addEventListener('click', () => setGitFilter('modified'));
  $('stat-untracked')?.addEventListener('click', () => setGitFilter('untracked'));

  // Visibility change handler to save resources
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchData(false);
    } else if (pollTimeout) {
      clearTimeout(pollTimeout);
    }
  });

  // Timer loop (1 second)
  timerInterval = setInterval(updateTimer, 1000);

  // Clean up on unload
  window.addEventListener('beforeunload', () => {
    if (timerInterval) clearInterval(timerInterval);
    if (pollTimeout) clearTimeout(pollTimeout);
  });

  // Initial fetch
  fetchData(false);
}

init();

