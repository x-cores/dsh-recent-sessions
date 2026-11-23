/**
 * @local/sessions-window —— host 半。
 *
 * 无 Host 侧逻辑：会话数据全部来自浏览器端官方快照
 * （ctx.get('sessions').list / ctx.get('workspaces').list），
 * 与官方侧栏同一份事实；过滤列表与分页偏好存 localStorage。
 */
export function apply() {}
