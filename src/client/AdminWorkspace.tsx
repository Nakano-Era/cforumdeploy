import { useEffect, useRef, useState } from "react";
import { getAdminSettings, updateAdminSettings, type AdminSettings } from "./admin";
import { ApiRequestError } from "./api";
import {
  createSingleUseInvite,
  getAdminInvites,
  revokeAdminInvite,
  type AdminInvite,
} from "./invites";

interface AdminWorkspaceProps {
  csrfToken: string | null;
  initialMaintenanceMode: boolean;
  onAuthenticationRequired: () => void;
  onExit: () => void;
  onMaintenanceModeChange: (enabled: boolean) => void;
  onNotice: (message: string) => void;
  siteName: string;
}

type WorkspaceStatus = "loading" | "ready" | "error";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function inviteStatusLabel(invite: AdminInvite): string {
  if (invite.status === "active") return "可使用";
  if (invite.status === "exhausted") return "已使用";
  if (invite.status === "expired") return "已过期";
  return "已撤销";
}

function adminFailureMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "管理服务暂时不可用，请检查网络后重试。";
  if (error.status === 401) return "登录状态已经失效。";
  if (error.status === 403) return "当前账号没有管理员权限。";
  if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请刷新页面后重试。";
  if (error.code === "INVITE_SERVICE_UNAVAILABLE") return "邀请服务尚未配置安全密钥，请先检查 Worker secrets。";
  if (error.status === 404) return "这枚邀请不存在或已被移除。";
  return "操作没有完成，请稍后重试。";
}

function inviteRegistrationUrl(token: string): string {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("invite", token);
  return url.toString();
}

export default function AdminWorkspace({
  csrfToken,
  initialMaintenanceMode,
  onAuthenticationRequired,
  onExit,
  onMaintenanceModeChange,
  onNotice,
  siteName,
}: AdminWorkspaceProps) {
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [settings, setSettings] = useState<AdminSettings>({
    maintenanceMode: initialMaintenanceMode,
  });
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const authRequiredRef = useRef(onAuthenticationRequired);
  const maintenanceChangeRef = useRef(onMaintenanceModeChange);

  useEffect(() => {
    authRequiredRef.current = onAuthenticationRequired;
  }, [onAuthenticationRequired]);

  useEffect(() => {
    maintenanceChangeRef.current = onMaintenanceModeChange;
  }, [onMaintenanceModeChange]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    setCreatedToken(null);
    setCopyState("idle");

    void Promise.all([
      getAdminSettings(controller.signal),
      getAdminInvites(undefined, controller.signal),
    ])
      .then(([settingsResponse, inviteResponse]) => {
        setSettings(settingsResponse.settings);
        if (typeof settingsResponse.settings.maintenanceMode === "boolean") {
          maintenanceChangeRef.current(settingsResponse.settings.maintenanceMode);
        }
        setInvites(inviteResponse.items);
        setNextCursor(inviteResponse.nextCursor);
        setStatus("ready");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          authRequiredRef.current();
          return;
        }
        setError(adminFailureMessage(requestError));
        setStatus("error");
      });

    return () => controller.abort();
  }, [refreshVersion]);

  const maintenanceMode = settings.maintenanceMode ?? initialMaintenanceMode;

  const toggleMaintenance = async () => {
    if (!csrfToken || savingMaintenance) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    const nextValue = !maintenanceMode;
    setSavingMaintenance(true);
    setError("");
    try {
      await updateAdminSettings({ maintenanceMode: nextValue }, csrfToken);
      setSettings((current) => ({ ...current, maintenanceMode: nextValue }));
      onMaintenanceModeChange(nextValue);
      onNotice(nextValue ? "维护模式已开启：普通成员现在只能阅读" : "维护模式已关闭：社区写入已恢复");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setSavingMaintenance(false);
    }
  };

  const createInvite = async () => {
    if (!csrfToken || creatingInvite) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setCreatingInvite(true);
    setCreatedToken(null);
    setCopyState("idle");
    setError("");
    try {
      const response = await createSingleUseInvite(csrfToken);
      setInvites((current) => [response.invite, ...current.filter((item) => item.id !== response.invite.id)]);
      setCreatedToken(response.token);
      onNotice("一次性邀请已创建；请现在复制，离开后无法再次查看");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyInvite = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(inviteRegistrationUrl(createdToken));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getAdminInvites(nextCursor);
      setInvites((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(response.nextCursor);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (!csrfToken || revokingId) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setRevokingId(inviteId);
    setError("");
    try {
      const response = await revokeAdminInvite(inviteId, csrfToken);
      setInvites((current) => current.map((item) => item.id === inviteId ? response.invite : item));
      setConfirmRevokeId(null);
      onNotice("邀请已撤销");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <main className="admin-page" id="main-content">
      <header className="review-hero admin-hero">
        <div>
          <p className="eyebrow">ADMIN · 站点管理</p>
          <h1>保持社区可进入、可恢复</h1>
          <p>维护开关立即影响所有普通成员写入；邀请原文只在创建时显示一次。</p>
        </div>
        <button className="button button-secondary" onClick={onExit} type="button">返回社区</button>
      </header>

      {error && <div className="admin-error" role="alert">{error}</div>}

      {status === "loading" && (
        <section aria-busy="true" className="admin-loading">
          <span className="spinner" aria-hidden="true" /> 正在读取管理设置与邀请…
        </section>
      )}

      {status === "error" && (
        <section className="review-state review-error" role="alert">
          <div aria-hidden="true">!</div>
          <h2>管理资料暂时没有送达</h2>
          <p>{error}</p>
          <button className="button button-secondary" onClick={() => setRefreshVersion((value) => value + 1)} type="button">重新读取</button>
        </section>
      )}

      {status === "ready" && (
        <>
          <section className="admin-control-grid" aria-label="站点控制">
            <article className={maintenanceMode ? "admin-control-card is-alert" : "admin-control-card"}>
              <p className="eyebrow">写入控制</p>
              <h2>{maintenanceMode ? "维护模式已开启" : "社区正常运行"}</h2>
              <p>{maintenanceMode ? "普通成员仍可阅读，但发帖、回复、互动、举报与上传会被服务端拒绝。" : "普通成员可按权限正常发布、回复与互动。"}</p>
              <button
                className={maintenanceMode ? "button button-primary" : "button button-secondary"}
                disabled={savingMaintenance}
                onClick={() => void toggleMaintenance()}
                type="button"
              >
                {savingMaintenance ? "正在保存…" : maintenanceMode ? "关闭维护并恢复写入" : "开启只读维护"}
              </button>
            </article>

            <article className="admin-control-card">
              <p className="eyebrow">注册邀请</p>
              <h2>创建一次性邀请</h2>
              <p>每枚邀请只能成功注册一个账号。服务器只保存不可逆摘要，原始链接离开本页后无法找回。</p>
              <button className="button button-primary" disabled={creatingInvite} onClick={() => void createInvite()} type="button">
                {creatingInvite ? "正在安全生成…" : "生成新邀请"}
              </button>
            </article>
          </section>

          {createdToken && (
            <section aria-live="polite" className="created-invite-card">
              <div>
                <p className="eyebrow">仅显示这一次</p>
                <h2>{siteName} 注册邀请</h2>
                <p>请立即复制并通过可信渠道发送。关闭此卡或离开管理页后，链接不会保留。</p>
              </div>
              <label>
                <span>邀请链接</span>
                <input onFocus={(event) => event.currentTarget.select()} readOnly value={inviteRegistrationUrl(createdToken)} />
              </label>
              <div className="created-invite-actions">
                <button className="button button-primary" onClick={() => void copyInvite()} type="button">
                  {copyState === "copied" ? "已复制" : "复制邀请链接"}
                </button>
                <button className="button button-quiet" onClick={() => { setCreatedToken(null); setCopyState("idle"); }} type="button">我已妥善保存</button>
                {copyState === "failed" && <small role="alert">浏览器拒绝自动复制，请手动选择上方链接。</small>}
              </div>
            </section>
          )}

          <section className="admin-invite-list" aria-labelledby="invite-list-title">
            <div className="admin-section-heading">
              <div>
                <p className="eyebrow">邀请记录</p>
                <h2 id="invite-list-title">最近创建的邀请</h2>
              </div>
              <button className="review-refresh" onClick={() => setRefreshVersion((value) => value + 1)} type="button"><span aria-hidden="true">↻</span> 刷新</button>
            </div>

            {invites.length === 0 ? (
              <div className="admin-empty">还没有邀请。创建后，这里只显示状态，不会显示原始 token。</div>
            ) : (
              <div className="admin-invite-table" role="table" aria-label="邀请列表">
                {invites.map((invite) => (
                  <article className="admin-invite-row" key={invite.id} role="row">
                    <div>
                      <span className={`invite-status invite-status-${invite.status}`}>{inviteStatusLabel(invite)}</span>
                      <strong>{invite.id.slice(0, 8)}</strong>
                      <small>由 {invite.createdBy.displayName} 创建 · {formatDate(invite.createdAt)}</small>
                    </div>
                    <div className="invite-usage"><strong>{invite.usedCount}/{invite.maxUses}</strong><small>已使用</small></div>
                    <div className="invite-row-actions">
                      {invite.status === "active" && confirmRevokeId !== invite.id && (
                        <button className="button button-quiet" onClick={() => setConfirmRevokeId(invite.id)} type="button">撤销</button>
                      )}
                      {invite.status === "active" && confirmRevokeId === invite.id && (
                        <>
                          <button className="button button-danger" disabled={revokingId === invite.id} onClick={() => void revokeInvite(invite.id)} type="button">
                            {revokingId === invite.id ? "正在撤销…" : "确认撤销"}
                          </button>
                          <button className="button button-quiet" disabled={revokingId === invite.id} onClick={() => setConfirmRevokeId(null)} type="button">取消</button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}

            {nextCursor && (
              <button className="load-more review-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">
                {loadingMore ? "正在载入…" : "继续载入更早的邀请"}
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
