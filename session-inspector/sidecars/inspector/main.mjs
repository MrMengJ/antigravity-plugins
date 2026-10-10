import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SidecarApp, Response } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const app = new SidecarApp();

// Safe static asset loader
function readLocal(name) {
  try {
    return readFileSync(join(HERE, name), 'utf8');
  } catch (err) {
    console.error(`[sidecar] Failed to read static file ${name}:`, err.message);
    return '';
  }
}

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), {
  contentType: 'text/css',
  headers: {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  },
}), 'GET');

// In-memory stats cache: conversationId -> { mtime, size, data }
const statsCache = new Map();

// Helper to find latest conversation directory if none provided
function getFallbackConversationId() {
  const brainDir = join(homedir(), '.gemini', 'antigravity', 'brain');
  if (!existsSync(brainDir)) return null;
  try {
    const entries = readdirSync(brainDir, { withFileTypes: true });
    let latestId = null;
    let latestMtime = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const transcriptPath = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(transcriptPath)) {
          const mtime = statSync(transcriptPath).mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestId = entry.name;
          }
        }
      }
    }
    return latestId;
  } catch (err) {
    console.error('[sidecar] Error finding fallback conversation:', err.message);
    return null;
  }
}

// Extract conversation stats with incremental caching & robust metrics
function parseConversationStats(conversationId) {
  if (!conversationId) return null;
  const brainDir = join(homedir(), '.gemini', 'antigravity', 'brain', conversationId);
  const transcriptPath = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');

  if (!existsSync(transcriptPath)) {
    return null;
  }

  try {
    const fileStat = statSync(transcriptPath);
    const cached = statsCache.get(conversationId);
    if (cached && cached.mtime === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.data;
    }

    const rawContent = readFileSync(transcriptPath, 'utf8').trim();
    if (!rawContent) return null;

    const lines = rawContent.split('\n').map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (lines.length === 0) return null;

    const firstStep = lines[0];
    const lastStep = lines[lines.length - 1];
    const startTime = firstStep.created_at || null;
    const lastTime = lastStep.created_at || null;

    let totalInput = 0;
    let totalOutput = 0;
    let totalCache = 0;

    let totalUserTurns = 0;
    let lastUserTurnIndex = -1;
    let modelName = 'Gemini 3.8 Flash';

    const toolCounts = {};
    const recentToolCalls = [];
    const skillsUsed = new Set();
    const mcpsUsed = new Set();

    // Generation speed tracking
    let totalGenDurationSec = 0;
    let totalGenTokens = 0;
    let latestGenSpeed = 0;
    let detectedWorkspacePath = null;
    const turnContextSizes = [];
    let waitingPlannerForTurn = false;

    // Scan steps
    for (let i = 0; i < lines.length; i++) {
      const step = lines[i];

      // Detect workspace from system/user messages or tool calls
      if (!detectedWorkspacePath) {
        if (step.content && typeof step.content === 'string') {
          const wsMatch = step.content.match(/Active Workspaces:\s*\n-\s*([^\n\r]+)/);
          if (wsMatch) {
            detectedWorkspacePath = wsMatch[1].trim();
          }
        }
        if (Array.isArray(step.tool_calls)) {
          for (const call of step.tool_calls) {
            if (call.args?.Cwd) {
              detectedWorkspacePath = String(call.args.Cwd).replace(/^["']|["']$/g, '');
              break;
            }
          }
        }
        if (Array.isArray(step.spec?.workspaceUris) && step.spec.workspaceUris.length > 0) {
          detectedWorkspacePath = step.spec.workspaceUris[0].replace(/^file:\/\//, '');
        }
      }

      if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
        totalUserTurns++;
        lastUserTurnIndex = i;
        waitingPlannerForTurn = true;
        if (step.content && typeof step.content === 'string') {
          // Detect model selection changes in metadata
          const modelMatch = step.content.match(/Model Selection` from \S+ to (.*?)(?:\.\s+[A-Z]|$)/i);
          if (modelMatch) {
            modelName = modelMatch[1].trim().replace(/\s*\([^)]*\)$/, '');
          }

          // Detect skill prompts like <SKILL>...the "xyz" skill...</SKILL>
          const skillMatch = step.content.match(/the "([a-zA-Z0-9_\-]+)" skill/i);
          if (skillMatch) {
            skillsUsed.add(skillMatch[1].replace(/_/g, '-'));
          }

          // Detect slash commands only inside USER_REQUEST
          const userReqMatch = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          const userText = userReqMatch ? userReqMatch[1] : step.content;
          const slashMatches = userText.matchAll(/^\/([a-zA-Z0-9_\-]+)/gm);
          for (const sm of slashMatches) {
            const cmd = sm[1].replace(/_/g, '-');
            if (cmd !== 'help' && cmd !== 'exit' && cmd !== 'quit' && cmd !== 'Users' && cmd !== 'Applications') {
              skillsUsed.add(cmd);
            }
          }
        }
      }

      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
        const inTok = step.input_tokens || 0;
        const outTok = step.output_tokens || 0;
        const cacheTok = step.cache_read_tokens || 0;

        if (waitingPlannerForTurn) {
          turnContextSizes.push(inTok + cacheTok);
          waitingPlannerForTurn = false;
        }

        totalInput += inTok;
        totalOutput += outTok;
        totalCache += cacheTok;

        // Calculate actual generation time: from current step to next step
        if (outTok > 0 && i < lines.length - 1 && lines[i + 1].created_at) {
          const curTime = new Date(step.created_at).getTime();
          const nextTime = new Date(lines[i + 1].created_at).getTime();
          const durSec = (nextTime - curTime) / 1000;
          if (durSec >= 0.5 && durSec <= 180) {
            totalGenDurationSec += durSec;
            totalGenTokens += outTok;
            latestGenSpeed = Math.round(outTok / durSec);
          }
        }

        if (Array.isArray(step.tool_calls)) {
          for (const call of step.tool_calls) {
            const tName = call.name || 'unknown';
            toolCounts[tName] = (toolCounts[tName] || 0) + 1;

            if (tName === 'view_file' && call.args?.AbsolutePath?.includes('/skills/')) {
              const sm = call.args.AbsolutePath.match(/\/skills\/([a-zA-Z0-9_\-]+)\//);
              if (sm) skillsUsed.add(sm[1].replace(/_/g, '-'));
            }

            if (tName.startsWith('mcp_') || tName.startsWith('mcp__')) {
              mcpsUsed.add(tName);
            }

            if (recentToolCalls.length < 20) {
              recentToolCalls.push({
                name: tName,
                action: call.args?.toolAction || tName,
                summary: call.args?.toolSummary || '',
                time: step.created_at || '',
              });
            }
          }
        }
      }
    }

    // Calculate aggregated tokens for the latest turn and active context window
    let lastTurnInput = 0;
    let lastTurnOutput = 0;
    let lastTurnCache = 0;
    let currentContextWindowTokens = 0; // True context window utilization

    // 1. Locate the most recent MODEL step to get active context window tokens
    for (let i = lines.length - 1; i >= 0; i--) {
      const step = lines[i];
      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
        const inT = step.input_tokens || 0;
        const cacheT = step.cache_read_tokens || 0;
        if (inT > 0 || cacheT > 0) {
          currentContextWindowTokens = inT + cacheT;
          break;
        }
      }
    }

    // 2. Sum tokens for the latest user turn
    if (lastUserTurnIndex >= 0) {
      for (let i = lastUserTurnIndex + 1; i < lines.length; i++) {
        const step = lines[i];
        if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
          lastTurnInput += (step.input_tokens || 0);
          lastTurnOutput += (step.output_tokens || 0);
          lastTurnCache += (step.cache_read_tokens || 0);
        }
      }
    }

    // 3. If user just asked a question and model is currently generating,
    // gracefully fall back to the most recent completed turn
    if (lastTurnInput === 0 && lastTurnOutput === 0 && lastUserTurnIndex > 0) {
      let prevUserTurnIndex = -1;
      for (let i = lastUserTurnIndex - 1; i >= 0; i--) {
        if (lines[i].source === 'USER_EXPLICIT' && lines[i].type === 'USER_INPUT') {
          prevUserTurnIndex = i;
          break;
        }
      }
      if (prevUserTurnIndex >= 0) {
        for (let i = prevUserTurnIndex + 1; i < lastUserTurnIndex; i++) {
          const step = lines[i];
          if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
            lastTurnInput += (step.input_tokens || 0);
            lastTurnOutput += (step.output_tokens || 0);
            lastTurnCache += (step.cache_read_tokens || 0);
          }
        }
      }
    }

    // Accurately compute compaction events and retained turns from turn context progression
    let compactionCount = 0;
    let lastCompactionTurn = 0;
    for (let t = 1; t < turnContextSizes.length; t++) {
      const prev = turnContextSizes[t - 1];
      const curr = turnContextSizes[t];
      // A drop of > 25% on a substantial context (> 45k tokens) indicates an automatic compaction
      if (prev > 45000 && curr < prev * 0.75) {
        compactionCount++;
        lastCompactionTurn = t + 1; // 1-indexed turn
      }
    }

    const retainedUserTurns = compactionCount > 0
      ? Math.max(1, turnContextSizes.length - lastCompactionTurn + 1)
      : totalUserTurns;

    const avgSpeed = (totalGenDurationSec > 0 && totalGenTokens > 0)
      ? Math.round(totalGenTokens / totalGenDurationSec)
      : latestGenSpeed;

    // Artifacts in brain directory
    const artifacts = [];
    try {
      const artifactEntries = readdirSync(brainDir, { withFileTypes: true });
      for (const ent of artifactEntries) {
        if (!ent.name.startsWith('.') && ent.isFile() && !ent.name.endsWith('.metadata.json')) {
          const filePath = join(brainDir, ent.name);
          const st = statSync(filePath);
          let summary = '';
          const metaPath = join(brainDir, `${ent.name}.metadata.json`);
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
              summary = meta.summary || meta.description || '';
            } catch {
              // ignore
            }
          }
          artifacts.push({
            name: ent.name,
            path: filePath,
            size: st.size,
            mtime: st.mtimeMs,
            summary,
            isImage: /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(ent.name),
            isMarkdown: /\.md$/i.test(ent.name),
          });
        }
      }
    } catch {
      // ignore
    }

    // Check user uploaded files as well
    const userUploadsDir = join(brainDir, '.user_uploaded');
    if (existsSync(userUploadsDir)) {
      try {
        const uploadEntries = readdirSync(userUploadsDir, { withFileTypes: true });
        for (const ent of uploadEntries) {
          if (!ent.name.startsWith('.') && ent.isFile() && !ent.name.endsWith('.metadata.json')) {
            const filePath = join(userUploadsDir, ent.name);
            const st = statSync(filePath);
            artifacts.push({
              name: ent.name,
              path: filePath,
              size: st.size,
              mtime: st.mtimeMs,
              summary: '用户上传媒体文件',
              isImage: /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(ent.name),
              isMarkdown: /\.md$/i.test(ent.name),
            });
          }
        }
      } catch {
        // ignore
      }
    }

    artifacts.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    // Memory files scan and estimation
    const memoryDir = join(homedir(), '.agents/memory');
    const memoryFiles = [];
    let memoryBytes = 0;
    if (existsSync(memoryDir)) {
      try {
        const mEntries = readdirSync(memoryDir, { withFileTypes: true });
        for (const ent of mEntries) {
          if (ent.isFile() && ent.name.endsWith('.md')) {
            const sz = statSync(join(memoryDir, ent.name)).size;
            memoryBytes += sz;
            memoryFiles.push({ name: ent.name, size: sz, tokens: Math.round(sz / 3.2) });
          }
        }
      } catch {
        // ignore
      }
    }
    const globalAgentsMd = join(homedir(), '.agents/AGENTS.md');
    if (existsSync(globalAgentsMd)) {
      try {
        const sz = statSync(globalAgentsMd).size;
        memoryBytes += sz;
        memoryFiles.push({ name: 'AGENTS.md', size: sz, tokens: Math.round(sz / 3.2) });
      } catch {
        // ignore
      }
    }

    const memoryTokens = Math.max(1000, Math.round(memoryBytes / 3.2));
    const systemPromptTokens = 6000;
    const systemToolsTokens = 16700;
    const skillsTokens = 9900;
    const mcpTokens = mcpsUsed.size > 0 ? mcpsUsed.size * 3000 : 0;
    const autocompactBufferTokens = 33000;
    const contextLimit = 1000000; // 1M for Gemini Flash/Pro

    const winTokens = Math.min(contextLimit, Math.max(0, currentContextWindowTokens > 0 ? currentContextWindowTokens : (lastTurnInput + lastTurnCache)));
    const fixedTokens = systemPromptTokens + systemToolsTokens + memoryTokens + skillsTokens + mcpTokens;
    const messagesTokens = Math.max(0, winTokens - fixedTokens);
    const freeTokens = Math.max(0, contextLimit - winTokens - autocompactBufferTokens);

    const contextWindow = {
      limit: contextLimit,
      limitFormatted: '1M',
      used: winTokens,
      usedPercent: Math.round((winTokens / contextLimit) * 1000) / 10,
      compaction: {
        count: compactionCount,
        isCompacted: compactionCount > 0,
        retainedTurns: retainedUserTurns,
        totalTurns: totalUserTurns,
      },
      breakdown: {
        messages: { tokens: messagesTokens, percent: Math.round((messagesTokens / contextLimit) * 1000) / 10 },
        systemTools: { tokens: systemToolsTokens, percent: Math.round((systemToolsTokens / contextLimit) * 1000) / 10 },
        memory: { tokens: memoryTokens, percent: Math.round((memoryTokens / contextLimit) * 1000) / 10, files: memoryFiles },
        mcpTools: { tokens: mcpTokens, percent: Math.round((mcpTokens / contextLimit) * 1000) / 10 },
        skills: { tokens: skillsTokens, percent: Math.round((skillsTokens / contextLimit) * 1000) / 10 },
        systemPrompt: { tokens: systemPromptTokens, percent: Math.round((systemPromptTokens / contextLimit) * 1000) / 10 },
        autocompactBuffer: { tokens: autocompactBufferTokens, percent: Math.round((autocompactBufferTokens / contextLimit) * 1000) / 10 },
        freeSpace: { tokens: freeTokens, percent: Math.round((freeTokens / contextLimit) * 1000) / 10 },
      },
    };

    const totalSum = totalInput + totalOutput + totalCache;
    const lastSum = lastTurnInput + lastTurnOutput + lastTurnCache;
    const totalCacheHitRate = (totalInput + totalCache > 0)
      ? Math.round((totalCache / (totalInput + totalCache)) * 1000) / 10
      : 0;

    const lastCacheHitRate = (lastTurnInput + lastTurnCache > 0)
      ? Math.round((lastTurnCache / (lastTurnInput + lastTurnCache)) * 1000) / 10
      : 0;

    const data = {
      conversationId,
      startTime,
      lastTime,
      modelName,
      totalSteps: lines.length,
      totalUserTurns,
      currentContextTokens: currentContextWindowTokens,
      contextWindow,
      tokens: {
        total: {
          sum: totalSum,
          in: totalInput,
          out: totalOutput,
          cache: totalCache,
          cacheHitRate: totalCacheHitRate,
        },
        latest: {
          sum: lastSum,
          in: lastTurnInput,
          out: lastTurnOutput,
          cache: lastTurnCache,
          cacheHitRate: lastCacheHitRate,
        },
      },
      speed: {
        latest: latestGenSpeed,
        average: avgSpeed,
      },
      toolCounts,
      recentTools: recentToolCalls.slice(-8).reverse(),
      skillsUsed: Array.from(skillsUsed),
      mcpsUsed: Array.from(mcpsUsed),
      artifacts,
      workspacePath: detectedWorkspacePath,
    };

    statsCache.set(conversationId, {
      mtime: fileStat.mtimeMs,
      size: fileStat.size,
      data,
    });

    return data;
  } catch (err) {
    console.error('[sidecar] Error parsing transcript:', err);
    return null;
  }
}

// Git inspector with timeout, maxBuffer, and porcelain safety
function parseGitInfo(workspacePath) {
  if (!workspacePath) return { isGit: false };

  let targetDir = workspacePath;
  if (targetDir.startsWith('file://')) {
    try {
      targetDir = fileURLToPath(targetDir);
    } catch {
      // fallback
    }
  }

  if (!existsSync(targetDir)) {
    return { isGit: false, path: targetDir };
  }

  // Ensure targetDir is a directory
  try {
    const s = statSync(targetDir);
    if (!s.isDirectory()) {
      targetDir = dirname(targetDir);
    }
  } catch {
    return { isGit: false, path: targetDir };
  }

  const gitOptions = {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  };

  try {
    const isGit = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], gitOptions).trim() === 'true';
    if (!isGit) return { isGit: false, path: targetDir };

    let branch = '';
    try {
      branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], gitOptions).trim();
    } catch {
      try {
        branch = execFileSync('git', ['branch', '--show-current'], gitOptions).trim();
      } catch {
        try {
          branch = execFileSync('git', ['rev-parse', '--short', 'HEAD'], gitOptions).trim() + ' (detached)';
        } catch {
          branch = 'HEAD (new repo)';
        }
      }
    }

    let currentWorktree = '主工作区 (默认)';
    let isLinkedWorktree = false;
    try {
      const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], gitOptions).trim();
      if (gitDir.includes('/worktrees/') || gitDir.includes('\\worktrees\\')) {
        isLinkedWorktree = true;
        currentWorktree = basename(gitDir);
      } else {
        const wtListRaw = execFileSync('git', ['worktree', 'list', '--porcelain'], gitOptions);
        const count = (wtListRaw.match(/^worktree /gm) || []).length;
        if (count > 1) {
          currentWorktree = `主工作区 (共 ${count} 个)`;
        } else {
          currentWorktree = '主工作区 (默认)';
        }
      }
    } catch {
      // keep fallback
    }

    // Git Status
    let modified = 0;
    let staged = 0;
    let untracked = 0;
    let deleted = 0;
    let conflict = 0;
    const changedFiles = [];

    try {
      // Use core.quotepath=false so Chinese characters are not escaped
      const statusRaw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain'], gitOptions);
      const lines = statusRaw.split('\n').filter(Boolean);
      for (const line of lines) {
        const x = line[0];
        const y = line[1];
        const rawFile = line.slice(3).trim();
        const file = rawFile.includes(' -> ') ? rawFile.split(' -> ')[1] : rawFile;

        const isConflict = (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'));
        const isUntracked = (x === '?' && y === '?');
        const isStaged = !isConflict && !isUntracked && (x !== ' ');
        const isModified = !isConflict && !isUntracked && (y !== ' ');

        if (isConflict) conflict++;
        if (isStaged) staged++;
        if (isModified) modified++;
        if (isUntracked) untracked++;
        if (x === 'D' || y === 'D') deleted++;

        changedFiles.push({
          status: (x + y).trim(),
          file,
          isStaged,
          isModified,
          isUntracked,
          isConflict,
        });
      }
    } catch {
      // ignore
    }

    let diffStat = '';
    try {
      diffStat = execFileSync('git', ['diff', '--shortstat'], gitOptions).trim();
    } catch {
      // ignore
    }

    return {
      isGit: true,
      path: targetDir,
      branch,
      currentWorktree,
      diffStat,
      stagedCount: staged,
      modifiedCount: modified,
      untrackedCount: untracked,
      deletedCount: deleted,
      conflictCount: conflict,
      totalChanges: changedFiles.length,
      changedFiles: changedFiles.slice(0, 100),
    };
  } catch {
    return { isGit: false, path: targetDir };
  }
}

// Main API: POST only (satisfies Sidecar SDK token authentication security)
app.api('/api/inspect', (data) => {
  const query = data || {};
  let conversationId = query.conversationId;
  if (!conversationId) {
    conversationId = getFallbackConversationId();
  }

  const conversationStats = parseConversationStats(conversationId);
  const workspacePath = query.workspacePath || conversationStats?.workspacePath || null;
  const gitStats = parseGitInfo(workspacePath);

  return {
    ok: true,
    timestamp: Date.now(),
    conversation: conversationStats,
    git: gitStats,
  };
}, 'POST');

// Safe resolver to ensure file path is strictly within the conversation or brain directory
function resolveSafeArtifactPath(conversationId, targetPath) {
  if (!targetPath) return null;
  const brainBase = join(homedir(), '.gemini/antigravity/brain');
  const target = resolve(targetPath);

  if (conversationId && conversationId.length >= 8) {
    const convBrain = join(brainBase, conversationId);
    if (target.startsWith(convBrain)) {
      return target;
    }
  }

  if (target.startsWith(brainBase)) {
    return target;
  }
  return null;
}

// Open Artifact in System Default App / IDE (POST)
app.api('/api/open-artifact', (req) => {
  const query = req || {};
  const { conversationId, path: rawPath, reveal } = query;
  if (!rawPath) return { ok: false, error: '缺少文件路径' };

  const safePath = resolveSafeArtifactPath(conversationId, rawPath);
  if (!safePath || !existsSync(safePath)) {
    return { ok: false, error: '文件不存在或拒绝访问' };
  }

  try {
    const args = reveal ? ['-R', safePath] : [safePath];
    execFileSync('/usr/bin/open', args, { timeout: 3000 });
    return { ok: true, path: safePath };
  } catch (err) {
    try {
      execFileSync('/usr/bin/open', ['-R', safePath], { timeout: 3000 });
      return { ok: true, path: safePath, revealed: true };
    } catch (fallbackErr) {
      return { ok: false, error: `打开失败: ${fallbackErr.message}` };
    }
  }
}, 'POST');

// Clipboard copy endpoint (reliably works inside Electron iframes via pbcopy)
app.api('/api/copy', (req) => {
  const { text } = req || {};
  if (!text) return { ok: false, error: '缺少内容' };
  try {
    execFileSync('/usr/bin/pbcopy', [], { input: String(text), timeout: 2000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'POST');

// Image data endpoint: returns base64 data URL for in-panel image preview
app.api('/api/image-data', (req) => {
  const { conversationId, path: rawPath } = req || {};
  if (!rawPath) return { ok: false, error: '缺少图片路径' };

  const safePath = resolveSafeArtifactPath(conversationId, rawPath);
  if (!safePath || !existsSync(safePath)) {
    return { ok: false, error: '图片不存在或拒绝访问' };
  }

  const ext = extname(safePath).toLowerCase().replace('.', '');
  const mimeTypes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };

  const mime = mimeTypes[ext] || 'application/octet-stream';
  try {
    const buf = readFileSync(safePath);
    const base64 = buf.toString('base64');
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${base64}`,
      name: basename(safePath),
      path: safePath,
      size: buf.length,
    };
  } catch (err) {
    return { ok: false, error: `读取图片失败: ${err.message}` };
  }
}, 'POST');

app.run();
