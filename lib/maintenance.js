const GC_RETRY_BACKOFF_MS = 18e5;
const GC_TIMEOUT_MS = 18e5;
function selectOverLimitVictims(snapshots, limit) {
  if (!limit || limit <= 0) return /* @__PURE__ */ new Map();
  const byRoot = /* @__PURE__ */ new Map();
  for (const [id, s] of snapshots.entries()) {
    if (!s || !s.root) continue;
    const list = byRoot.get(s.root);
    if (list) list.push({ id, time: s.time });
    else byRoot.set(s.root, [{ id, time: s.time }]);
  }
  const victims = /* @__PURE__ */ new Map();
  for (const [root, list] of byRoot) {
    if (list.length <= limit) continue;
    const excess = list.length - limit;
    list.sort((a, b) => (a.time || 0) - (b.time || 0));
    victims.set(root, list.slice(0, excess));
  }
  return victims;
}
function selectExpiredVictims(snapshots, retentionDays, now) {
  if (!retentionDays || retentionDays <= 0) return /* @__PURE__ */ new Map();
  const cutoff = (typeof now === "number" ? now : Date.now()) - retentionDays * 864e5;
  const byRoot = /* @__PURE__ */ new Map();
  for (const [id, s] of snapshots.entries()) {
    if (!s || !s.root) continue;
    if (s.time > 0 && s.time >= cutoff) continue;
    if (!byRoot.has(s.root)) byRoot.set(s.root, []);
    byRoot.get(s.root).push({ id, time: s.time });
  }
  return byRoot;
}
function createMaintenance(ctx, rt, snaps, config, deps = {}) {
  const sessions = ctx.sessions;
  const state = rt.state;
  const S = rt.scripts;
  async function purgeSession(sessionId) {
    const byRoot = /* @__PURE__ */ new Map();
    for (const [id, s] of state.snapshots.entries()) {
      if (!s || s.sessionId !== sessionId) continue;
      const list = byRoot.get(s.root);
      if (list) list.push(id);
      else byRoot.set(s.root, [id]);
    }
    let purged = 0;
    for (const [root, ids] of byRoot) {
      let store = state.stores.get(root) || null;
      if (!store) {
        try {
          store = await rt.resolveStore(root);
        } catch (error) {
          store = null;
        }
      }
      if (!store || !state.gitExe) continue;
      if (!await snaps.guardStoreFormat(store)) continue;
      try {
        for (let i = 0; i < ids.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, ids.slice(i, i + 100).map((id) => "snap-" + id)), { timeoutMs: 12e4, stdoutMaxBytes: 4096 });
        }
        for (const id of ids) state.snapshots.delete(id);
        await snaps.saveIndex(root, sessionId);
        purged += ids.length;
      } catch (error) {
        rt.recordError("recall purge session failed: " + String(error));
      }
    }
    if (purged > 0) console.error("recall purged snapshots of deleted session:", sessionId, purged);
    return purged;
  }
  /**
   * 清理「会话已不存在」的快照。
   *
   * 相对上游的三处修正，逐条对应实测到的故障：
   *
   * 1. **先把磁盘 index 全部装进内存再扫**。原实现只遍历 state.snapshots，
   *    而它可能只加载了当前工作区甚至一条都没加载（warmup 未覆盖时），
   *    于是明明磁盘上躺着孤儿快照，sweep 却视而不见，点了「立即 gc」也清不掉。
   * 2. **归属为空的快照按孤儿处理**。rebuildOrphans 过去会给无主 tag 编造
   *    当前会话 id，修好后这类记录 sessionId 为空，必须能在这里被回收。
   * 3. **回收前二次确认会话真的没了**。磁盘索引与内存两路都要查不到，
   *    才允许删——避免启动早期 sessionQuery 尚未就绪时误删活会话的快照。
   * 4. **待扫工作区取自磁盘扫描，不止内存**。第 1 条的 roots 若只从
   *    state.snapshots 推导，「本进程从未载入过的工作区」仍会漏扫；
   *    runGcAll 已经把全部工作区 dump 出来了，直接接住这份清单即可闭环。
   */
  async function sweepDeletedSessions(diskHints) {
    // 1. 保证内存里有磁盘上的全部快照
    try {
      const roots = new Set();
      for (const s of state.snapshots.values()) {
        if (s && s.root) roots.add(s.root);
      }
      // 4. 磁盘扫描到的工作区一并纳入；顺手补 store，否则 reloadIndex
      //    取不到 store 会静默返回，孤儿快照依旧看不见。
      if (diskHints) {
        for (const [dir, info] of diskHints) {
          const root = info && info.root;
          if (!dir || !root) continue;
          roots.add(root);
          if (!state.stores.has(root)) state.stores.set(root, rt.storeFromDir(dir, false));
        }
      }
      for (const root of roots) {
        try {
          // reloadIndex 会清掉 indexLoaded 守卫并按磁盘原文重建归属，
          // 这样才能纠正历史上被 rebuildOrphans 冒认过的 sessionId。
          await snaps.reloadIndex(root);
        } catch (error) {
          rt.recordError("sweep reloadIndex failed for " + root + ": " + String(error));
        }
      }
    } catch (error) {
      rt.recordError("sweep preload failed: " + String(error));
    }

    const ids = /* @__PURE__ */ new Set();
    let orphanCount = 0;
    for (const s of state.snapshots.values()) {
      if (!s) continue;
      if (s.sessionId) ids.add(s.sessionId);
      else orphanCount += 1;
    }
    if (!ids.size && orphanCount === 0) return;

    const query = ctx.get("sessionQuery");
    if (!query || typeof query.listSessions !== "function") return;
    let diskIds;
    try {
      diskIds = new Set((await query.listSessions() || []).map((r) => r && r.header && r.header.id).filter((v) => Boolean(v)));
    } catch (error) {
      return;
    }

    // 2. 归属为空的：直接回收（这些 tag 已无法对应任何会话）
    if (orphanCount > 0) {
      const orphanIds = [];
      for (const [id, s] of state.snapshots.entries()) {
        if (s && !s.sessionId) orphanIds.push(id);
      }
      if (orphanIds.length > 0) await purgeSnapshotsByIds(orphanIds);
    }

    // 3. 有名有姓的：内存 + 磁盘都没这个会话才删
    for (const id of ids) {
      if (sessions.get(id)) continue;
      if (diskIds.has(id)) continue;
      await purgeSession(id);
    }
  }

  /** 按快照 id 直接回收（不依赖会话归属）。 */
  async function purgeSnapshotsByIds(ids) {
    const byRoot = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const s = state.snapshots.get(id);
      if (!s || !s.root) continue;
      const list = byRoot.get(s.root);
      if (list) list.push(id);
      else byRoot.set(s.root, [id]);
    }
    for (const [root, list] of byRoot) {
      let store = state.stores.get(root) || null;
      if (!store) {
        try {
          store = await rt.resolveStore(root);
        } catch (error) {
          store = null;
        }
      }
      if (!store || !state.gitExe) continue;
      if (!await snaps.guardStoreFormat(store)) continue;
      try {
        for (let i = 0; i < list.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, list.slice(i, i + 100).map((id) => "snap-" + id)), { timeoutMs: 12e4, stdoutMaxBytes: 4096 });
        }
        for (const id of list) state.snapshots.delete(id);
        await snaps.saveIndex(root, "");
      } catch (error) {
        rt.recordError("sweep purge orphan snapshots failed for " + root + ": " + String(error));
      }
    }
  }
  async function enforceLimits() {
    const victimsMap = selectOverLimitVictims(state.snapshots, config.maxSnapshotsPerWorkspace);
    if (!victimsMap.size) return 0;
    let dropped = 0;
    for (const [root, victims] of victimsMap) {
      let store = state.stores.get(root) || null;
      if (!store) {
        try {
          store = await rt.resolveStore(root);
        } catch (error) {
          store = null;
        }
      }
      if (!store || !state.gitExe) continue;
      if (!await snaps.guardStoreFormat(store)) continue;
      try {
        for (let i = 0; i < victims.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, victims.slice(i, i + 100).map((v) => "snap-" + v.id)), { timeoutMs: 12e4, stdoutMaxBytes: 4096 });
        }
        for (const v of victims) state.snapshots.delete(v.id);
        await snaps.saveIndex(root, null);
        dropped += victims.length;
        console.error("recall enforceLimits dropped " + victims.length + " oldest snapshots for: " + root + " (max " + config.maxSnapshotsPerWorkspace + ")");
      } catch (error) {
        rt.recordError("recall enforceLimits failed for " + root + ": " + String(error));
      }
    }
    return dropped;
  }
  async function enforceRetention() {
    const victimsMap = selectExpiredVictims(state.snapshots, config.retentionDays, Date.now());
    if (!victimsMap.size) return 0;
    let dropped = 0;
    for (const [root, victims] of victimsMap) {
      let store = state.stores.get(root) || null;
      if (!store) {
        try {
          store = await rt.resolveStore(root);
        } catch (error) {
          store = null;
        }
      }
      if (!store || !state.gitExe) continue;
      if (!await snaps.guardStoreFormat(store)) continue;
      try {
        for (let i = 0; i < victims.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, victims.slice(i, i + 100).map((v) => "snap-" + v.id)), { timeoutMs: 12e4, stdoutMaxBytes: 4096 });
        }
        for (const v of victims) state.snapshots.delete(v.id);
        await snaps.saveIndex(root, null);
        dropped += victims.length;
        console.error("recall enforceRetention dropped " + victims.length + " expired snapshots for: " + root + " (retention " + config.retentionDays + "d)");
      } catch (error) {
        rt.recordError("recall enforceRetention failed for " + root + ": " + String(error));
      }
    }
    return dropped;
  }
  async function runGc(sessionId, force) {
    const root = await rt.resolveRoot(sessionId);
    if (!root) return false;
    const store = state.stores.get(root);
    if (!store || !state.gitExe) return false;
    const now = Date.now();
    const last = state.gcLastAt.get(store.git) || 0;
    const count = (state.gcCount.get(store.git) || 0) + 1;
    state.gcCount.set(store.git, count);
    if (!force && count < config.gcSnaps && now - last < config.gcHours * 36e5) return false;
    state.gcCount.set(store.git, 0);
    let ok = false;
    try {
      // 单工作区路径没有全盘 dump：就地把本工作区的 store 目录当作提示传入，
      // 保证本进程还没载入过该工作区时也扫得到磁盘上的孤儿。
      await sweepDeletedSessions(new Map([[store.dir, { root }]]));
      await enforceLimits();
      await enforceRetention();
      await rt.runShell(S.gcScript(store, state.gitExe), { timeoutMs: GC_TIMEOUT_MS, stdoutMaxBytes: 4096 });
      ok = true;
    } catch (error) {
      rt.recordError("recall maintenance failed: " + String(error));
    }
    state.gcLastAt.set(store.git, ok ? Date.now() : Date.now() - config.gcHours * 36e5 + GC_RETRY_BACKOFF_MS);
    return true;
  }
  async function dumpDiskStores() {
    if (typeof deps.dumpStores !== "function") return /* @__PURE__ */ new Map();
    try {
      return await deps.dumpStores();
    } catch (error) {
      rt.recordError("recall disk store dump failed: " + String(error));
      return /* @__PURE__ */ new Map();
    }
  }
  function mergeStores(disk) {
    const byGit = /* @__PURE__ */ new Map();
    for (const store of state.stores.values()) {
      if (store && store.git) byGit.set(store.git, store);
    }
    for (const dir of disk.keys()) {
      if (!dir) continue;
      const store = rt.storeFromDir(dir, false);
      if (store && store.git && !byGit.has(store.git)) byGit.set(store.git, store);
    }
    return Array.from(byGit.values());
  }
  function memorySnapshotCount(dir, root) {
    let n = 0;
    for (const snap of state.snapshots.values()) {
      if (!snap) continue;
      const owner = state.stores.get(snap.root);
      if (owner && owner.dir === dir || root && snap.root === root) n++;
    }
    return n;
  }
  async function reapEmptyStores(disk) {
    if (!state.gitExe) return 0;
    let removed = 0;
    for (const [dir, info] of disk) {
      if (!dir || !info) continue;
      const emptyIndex = Array.isArray(info.entries) && info.entries.length === 0;
      const neverCaptured = info.entries === null && info.indexState === "absent";
      if (!emptyIndex && !neverCaptured) continue;
      if (memorySnapshotCount(dir, info.root) > 0) continue;
      const store = rt.storeFromDir(dir, false);
      try {
        const tags = S.stripBom(await rt.runShell(S.listTagsScript(store, state.gitExe), { timeoutMs: 6e4, stdoutMaxBytes: 4096 }));
        if (String(tags).trim()) continue;
        await rt.runShell(S.legacyRmScript(dir), { timeoutMs: 12e4, stdoutMaxBytes: 4096 });
        for (const [root, st] of state.stores.entries()) {
          if (st && st.dir === dir) state.stores.delete(root);
        }
        state.gcLastAt.delete(store.git);
        state.gcCount.delete(store.git);
        // 目录连同 .git 一起没了，但要同步作废 store.js 的建仓缓存：
        // 否则该工作区下一次 ensureGit 命中缓存直接返回 ok，后续快照脚本
        // 在空目录上跑，报 "fatal: not a git repository" 且每轮复现。
        state.gitReady.delete(store.git);
        if (info.root) state.indexLoaded.delete(info.root);
        console.error("recall reaped empty store:", dir);
        removed++;
      } catch (error) {
        rt.recordError("recall reap store failed for " + dir + ": " + String(error));
      }
    }
    return removed;
  }
  async function runGcAll() {
    if (!state.gitExe) return false;
    const disk = await dumpDiskStores();
    const stores = mergeStores(disk);
    if (!stores.length) return false;
    try {
      await sweepDeletedSessions(disk);
    } catch (error) {
      rt.recordError("recall sweep failed: " + String(error));
    }
    try {
      await enforceLimits();
    } catch (error) {
      rt.recordError("recall enforceLimits failed: " + String(error));
    }
    try {
      await enforceRetention();
    } catch (error) {
      rt.recordError("recall enforceRetention failed: " + String(error));
    }
    let done = 0;
    for (const store of stores) {
      try {
        await rt.runShell(S.gcScript(store, state.gitExe), { timeoutMs: GC_TIMEOUT_MS, stdoutMaxBytes: 4096 });
        done++;
        state.gcLastAt.set(store.git, Date.now());
      } catch (error) {
        rt.recordError("recall gc failed for " + (store && store.git) + ": " + String(error));
        state.gcLastAt.set(store.git, Date.now() - config.gcHours * 36e5 + GC_RETRY_BACKOFF_MS);
      }
      state.gcCount.set(store.git, 0);
    }
    await reapEmptyStores(disk);
    return true;
  }
  async function maybeMaintain(sessionId) {
    await runGc(sessionId, false);
  }
  return { maybeMaintain, runGc, runGcAll, enforceLimits, enforceRetention, sweepDeletedSessions };
}
export {
  createMaintenance,
  selectExpiredVictims,
  selectOverLimitVictims
};
