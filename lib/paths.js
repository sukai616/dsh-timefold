// 快照目录名。
//
// 沿革：本插件 fork 自 dsh-recall-plugin，早期版本把快照落在
// `dsh-recall-snapshots`。现在统一用 `dsh-timefold-snapshots`，不做旧库迁移
// （用户已明确不需要：旧记录清掉即可，新的能用就行）。
//
// 旧名仍留在排除表里，唯一原因：万一目录还在（或用户自行留着），
// 也不能被收进新快照，否则快照库会自吞并膨胀。
export const STORE_DIR = "dsh-timefold-snapshots";

/** 历史上用过的目录名，仅用于「排除表」。 */
export const LEGACY_STORE_DIRS = ["dsh-recall-snapshots"];

/** home 不可写时退化到项目内的隐藏目录（新旧都排除）。 */
export const PROJECT_FALLBACK_DIRS = [`.${STORE_DIR}`, ...LEGACY_STORE_DIRS.map((n) => `.${n}`)];

/** 所有必须从快照里排除的目录名。 */
export const EXCLUDE_DIRS = [STORE_DIR, ...LEGACY_STORE_DIRS];

export default { STORE_DIR, LEGACY_STORE_DIRS, PROJECT_FALLBACK_DIRS, EXCLUDE_DIRS };
