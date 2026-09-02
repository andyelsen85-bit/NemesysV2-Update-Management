import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Archive, ArrowDownRight, ArrowUpRight, Ban,
  Bell, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, Code2,
  FileCog, FileKey2, Gauge, Globe2, HardDrive, Laptop, LockKeyhole, Menu,
  MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Server,
  Settings2, ShieldCheck, ShieldX, Trash2, Upload, Users, LogOut, Wifi, X
} from 'lucide-react';
import {
  getGetClientSyncConfigQueryKey, getGetDashboardQueryKey, getGetServerSettingsQueryKey,
  getListAuditEntriesQueryKey, getListClientsQueryKey,
  getListSoftwareQueryKey, useCreateSoftware, useGetClientApiKey, useGetDashboard, useGetServerSettings,
  useGetClientSyncConfig, useHealthCheck, useListAuditEntries, useListClients, useListSoftware,
  useRevokeClient, useRotateClientApiKey, useSubmitSyncReport, useUpdateServerSettings, useUpdateSoftware
} from '@workspace/api-client-react';
import type {
  AdministratorUser, ApiKeyRotation, AuditEntry, Client, ClientApiKeyStatus, ExeCheck, IniCheck, IniRule, LdapSettings, ServerSettings,
  SoftwarePolicy, SoftwarePolicyInput, SslSettings, SyncConfig
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import './index.css';

const queryClient = new QueryClient();

const navItems = [
  { href: '/', label: 'Overview', icon: Gauge },
  { href: '/clients', label: 'Clients', icon: Laptop },
  { href: '/software', label: 'Software policies', icon: FileCog },
  { href: '/audit', label: 'Audit trail', icon: Archive },
  { href: '/administrators', label: 'Administrators', icon: Users },
  { href: '/security', label: 'Security', icon: ShieldCheck },
  { href: '/api-key', label: 'Client API key', icon: LockKeyhole },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

function cx(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(' ');
}

function formatTime(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function relativeTime(value?: string | null) {
  if (!value) return 'No sync recorded';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function initials(label: string) {
  return label.split(/[\s_-]+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function StatusPill({ value, kind = 'neutral' }: { value: string; kind?: 'online' | 'warning' | 'danger' | 'success' | 'neutral' }) {
  const styles = {
    online: 'bg-[#dff2e9] text-[#176244] border-[#b8dfc8]',
    warning: 'bg-[#fff0d4] text-[#8a5a08] border-[#f2d493]',
    danger: 'bg-[#f9e1dd] text-[#9d342b] border-[#ecc0b9]',
    success: 'bg-[#dff2e9] text-[#176244] border-[#b8dfc8]',
    neutral: 'bg-[#e9edf0] text-[#53616d] border-[#d5dde2]',
  };
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em]', styles[kind])}>
    {kind === 'online' || kind === 'success' ? <CheckCircle2 size={12} /> : kind === 'danger' ? <ShieldX size={12} /> : kind === 'warning' ? <AlertTriangle size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
    {value}
  </span>;
}

function Button({ children, variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={cx(
    'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-xs font-bold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[#2c9a76]/35 disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary' && 'bg-[#167151] text-[#fffdf8] shadow-[0_2px_0_#0f523b] hover:-translate-y-px hover:bg-[#1c805e] active:translate-y-0',
    variant === 'secondary' && 'border border-[#cad5d6] bg-[#fffdf8] text-[#253848] hover:border-[#85aa9b] hover:bg-[#f4f8f4]',
    variant === 'ghost' && 'text-[#61717b] hover:bg-[#e9efed] hover:text-[#173f33]',
    variant === 'danger' && 'border border-[#e7bbb5] bg-[#fff8f6] text-[#a13a31] hover:bg-[#f9e3df]',
    className
  )}>{children}</button>;
}

function IconMark() {
  return <div className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#a6e4c6] text-[#13382f] shadow-[inset_0_-2px_0_rgba(18,61,47,.15)]">
    <ShieldCheck size={22} strokeWidth={2.5} />
    <span className="absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full bg-[#e9aa38]" />
  </div>;
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="space-y-3 animate-pulse">{Array.from({ length: count }).map((_, i) => <div key={i} className="h-14 rounded-lg bg-[#e9eeeb]" />)}</div>;
}

function ErrorState({ message = 'The control plane did not respond.', onRetry }: { message?: string; onRetry?: () => void }) {
  return <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-[#e9c3bd] bg-[#fff8f6] p-8 text-center">
    <div className="mb-3 rounded-full bg-[#f9e2de] p-3 text-[#a13a31]"><AlertTriangle size={22} /></div>
    <p className="font-bold text-[#7e3029]">Unable to load this view</p>
    <p className="mt-1 max-w-sm text-sm text-[#9d6a62]">{message}</p>
    {onRetry && <Button variant="danger" onClick={onRetry} className="mt-4"><RotateCcw size={14} /> Try again</Button>}
  </div>;
}

function EmptyState({ icon: Icon, title, detail, action }: { icon: typeof Search; title: string; detail: string; action?: ReactNode }) {
  return <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-[#c9d5d0] bg-[#fbfcf8] p-8 text-center">
    <div className="mb-3 rounded-2xl bg-[#e5f1eb] p-3 text-[#30745b]"><Icon size={23} /></div>
    <p className="font-bold text-[#284139]">{title}</p>
    <p className="mt-1 max-w-sm text-sm text-[#71817c]">{detail}</p>
    {action && <div className="mt-4">{action}</div>}
  </div>;
}

function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? 'Unable to sign in.');
      }
      onAuthenticated();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  };
  return <div className="noise flex min-h-[100dvh] items-center justify-center bg-[#f4f5ef] px-5 text-[#1e3442]"><div className="w-full max-w-md rounded-2xl border border-[#dbe3dd] bg-[#fffdf8] p-7 shadow-[0_16px_50px_rgba(39,66,58,.08)]"><div className="flex items-center gap-3"><IconMark /><div><div className="text-sm font-extrabold tracking-tight text-[#1e3442]">NEMESYS<span className="text-[#2c8968]">V2</span></div><div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#83918b]">Control center</div></div></div><div className="mt-8"><div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2f8064]"><span className="h-1.5 w-1.5 rounded-full bg-[#e3a438]" />Administrator access</div><h1 className="text-3xl font-extrabold tracking-[-0.045em] text-[#1e3442]">Sign in to control center</h1><p className="mt-2 text-sm leading-6 text-[#71817c]">Manage Windows clients, application policies, and the shared sync channel.</p></div><form onSubmit={submit} className="mt-7 space-y-4"><label className="block"><span className="field-label">Username</span><input autoFocus autoComplete="username" required data-testid="input-login-username" value={username} onChange={(event) => setUsername(event.target.value)} className="field-input" /></label><label className="block"><span className="field-label">Password</span><input required autoComplete="current-password" type="password" data-testid="input-login-password" value={password} onChange={(event) => setPassword(event.target.value)} className="field-input" /></label>{feedback && <div role="alert" data-testid="text-login-error" className="rounded-lg bg-[#fff0d5] px-3 py-2 text-xs font-semibold text-[#8a5a08]">{feedback}</div>}<Button type="submit" disabled={busy} className="mt-2 w-full">{busy ? 'Signing in…' : 'Sign in'}</Button></form></div></div>;
}

function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'authenticated' | 'signed-out'>('checking');
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((response) => setState(response.ok ? 'authenticated' : 'signed-out'))
      .catch(() => setState('signed-out'));
  }, []);
  if (state === 'checking') return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f4f5ef]"><div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] px-5 py-4 text-sm font-semibold text-[#536b68]">Checking administrator session…</div></div>;
  if (state === 'signed-out') return <LoginPage onAuthenticated={() => setState('authenticated')} />;
  return <>{children}</>;
}

function PageHeader({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <header className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#2f8064]"><span className="h-1.5 w-1.5 rounded-full bg-[#e3a438]" />{eyebrow}</div>
      <h1 className="font-sans text-3xl font-extrabold tracking-[-0.045em] text-[#1e3442] md:text-[40px]">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[#71817c]">{detail}</p>
    </div>
    {action}
  </header>;
}

function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [account, setAccount] = useState('administrator');
  const health = useHealthCheck();
  const healthOnline = health.data?.status === 'ok' || health.data?.status === 'healthy';
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' }).then(async (response) => {
      if (response.ok) {
        const body = await response.json() as { username?: string };
        if (body.username) setAccount(body.username);
      }
    }).catch(() => undefined);
  }, []);
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.reload();
  };
  return <div className="noise min-h-[100dvh] bg-[#f4f5ef] text-[#1e3442]">
    <aside className={cx('fixed inset-y-0 left-0 z-40 flex w-[258px] flex-col border-r border-[#263c4a] bg-[#172d3b] px-4 py-5 text-[#dce8e4] transition-transform duration-300 lg:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="flex items-center gap-3 px-2">
        <IconMark />
        <div><div className="text-sm font-extrabold tracking-tight text-[#f1f3e8]">NEMESYS<span className="text-[#91dcb5]">V2</span></div><div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[#7d9699]">Control center</div></div>
        <button aria-label="Close navigation" data-testid="button-close-navigation" className="ml-auto rounded-md p-1 text-[#90a5a8] hover:bg-[#213e4d] lg:hidden" onClick={() => setMobileOpen(false)}><X size={17} /></button>
      </div>
      <div className="mt-10 px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#6c878d]">Operations</div>
      <nav className="mt-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`} onClick={() => setMobileOpen(false)} className={cx('group flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors', location === href ? 'bg-[#285246] text-[#e9f8ee] shadow-[inset_3px_0_0_#a5e3c4]' : 'text-[#a8bec0] hover:bg-[#203d4b] hover:text-[#e5f4ed]')}>
          <Icon size={17} className={location === href ? 'text-[#a5e3c4]' : 'text-[#789699]'} /><span>{label}</span>{location === href && <ChevronRight size={15} className="ml-auto text-[#80c9a2]" />}
        </Link>)}
      </nav>
      <div className="mt-auto">
        <div className="mb-4 rounded-xl border border-[#2d4c55] bg-[#1d3945] p-3.5">
          <div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#83a5a4]">Control plane</span><span className={cx('h-2 w-2 rounded-full', health.isLoading ? 'bg-[#d49a35]' : healthOnline ? 'bg-[#7ad69d]' : 'bg-[#cf756c]')} /></div>
          <div className="mt-2 font-mono text-xs text-[#d6e4dd]">{health.isLoading ? 'checking status' : healthOnline ? 'operational' : 'attention required'}</div>
           <div className="mt-2 font-mono text-[10px] text-[#769394]">shared API-key channel</div>
        </div>
         <div className="flex items-center gap-2.5 border-t border-[#2a4551] px-2 pt-4"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#d4e8df] text-xs font-extrabold text-[#285b4a]">{initials(account)}</div><div className="min-w-0"><div className="truncate text-xs font-bold text-[#e4eee8]">{account}</div><div className="font-mono text-[10px] text-[#789699]">administrator</div></div><button aria-label="Sign out" data-testid="button-logout" onClick={() => void logout()} className="ml-auto rounded-md p-1 text-[#789699] hover:bg-[#294854] hover:text-white"><LogOut size={16} /></button></div>
      </div>
    </aside>
    {mobileOpen && <button aria-label="Close menu overlay" data-testid="button-menu-overlay" className="fixed inset-0 z-30 bg-[#10232d]/50 lg:hidden" onClick={() => setMobileOpen(false)} />}
    <main className="min-h-[100dvh] lg:pl-[258px]">
      <div className="sticky top-0 z-20 flex h-[70px] items-center justify-between border-b border-[#dfe5df] bg-[#f4f5ef]/90 px-5 backdrop-blur-md md:px-9">
        <div className="flex items-center gap-3"><button aria-label="Open navigation" data-testid="button-open-navigation" onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-[#49616a] hover:bg-[#e5ece7] lg:hidden"><Menu size={20} /></button><div className="hidden items-center gap-2 text-xs text-[#80908c] sm:flex"><span>Workspace</span><ChevronRight size={13} /><span className="font-semibold text-[#38544d]">{navItems.find((item) => item.href === location)?.label ?? 'Not found'}</span></div></div>
        <div className="flex items-center gap-2.5"><div className="hidden items-center gap-2 rounded-lg border border-[#d8e1db] bg-[#fbfcf8] px-3 py-2 text-[11px] font-bold text-[#59706a] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#39a974]" />Production environment</div><button aria-label="Notifications" data-testid="button-notifications" className="relative rounded-lg p-2 text-[#6f817d] hover:bg-[#e5ece7]"><Bell size={18} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#e3a438]" /></button></div>
      </div>
      <div className="app-grid min-h-[calc(100dvh-70px)] px-5 py-7 md:px-9 md:py-9">{children}</div>
    </main>
  </div>;
}

function MetricCard({ label, value, detail, icon: Icon, tone = 'green', trend }: { label: string; value: string | number; detail: string; icon: typeof Gauge; tone?: 'green' | 'amber' | 'blue' | 'slate'; trend?: 'up' | 'down' }) {
  const tones = { green: 'bg-[#dff2e9] text-[#237455]', amber: 'bg-[#fff0d5] text-[#94661a]', blue: 'bg-[#dfeef1] text-[#286b76]', slate: 'bg-[#e8ebee] text-[#5b6a74]' };
  return <div className="group relative overflow-hidden rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#b7cec1]">
    <div className="flex items-start justify-between"><div className={cx('flex h-9 w-9 items-center justify-center rounded-lg', tones[tone])}><Icon size={18} /></div>{trend && <div className={cx('flex items-center gap-1 text-[10px] font-bold', trend === 'up' ? 'text-[#2c8b63]' : 'text-[#ad5b42]')}>{trend === 'up' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}<span>today</span></div>}</div>
    <div className="mt-5 font-mono text-[32px] font-medium tracking-[-0.06em] text-[#203946]">{value}</div><div className="mt-1 text-xs font-bold text-[#536b68]">{label}</div><div className="mt-2 text-[11px] text-[#86948e]">{detail}</div>
    <div className="absolute -bottom-7 -right-4 h-20 w-20 rounded-full border-[12px] border-[#eff5ef] opacity-70" />
  </div>;
}

function OverviewPage() {
  const dashboard = useGetDashboard();
  const clientsQuery = useListClients();
  const softwareQuery = useListSoftware();
  const auditQuery = useListAuditEntries({ limit: 5 });
  const summary = dashboard.data;
  const clients = clientsQuery.data ?? [];
  const policies = softwareQuery.data ?? [];
  const audits = auditQuery.data ?? [];
  const attention = clients.filter((client) => client.status !== 'online');
  const anyLoading = dashboard.isLoading || clientsQuery.isLoading || softwareQuery.isLoading || auditQuery.isLoading;
  const retry = () => { dashboard.refetch(); clientsQuery.refetch(); softwareQuery.refetch(); auditQuery.refetch(); };
  return <div className="mx-auto max-w-[1380px]">
    <PageHeader eyebrow="Operational overview" title="Good morning, Alex." detail="A precise read on the Windows estate, policy drift, and what needs your attention next." action={<Button variant="secondary" onClick={retry} disabled={anyLoading} data-testid="button-refresh-overview"><RefreshCw size={14} className={anyLoading ? 'animate-spin' : ''} /> Refresh data</Button>} />
    {dashboard.isError ? <ErrorState onRetry={retry} /> : anyLoading && !summary ? <LoadingRows count={5} /> : <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Enrolled clients" value={summary?.totalClients ?? '—'} detail={`${summary?.onlineClients ?? 0} online right now`} icon={Laptop} tone="green" trend="up" />
        <MetricCard label="Online coverage" value={summary && summary.totalClients ? `${Math.round((summary.onlineClients / summary.totalClients) * 100)}%` : '—'} detail="clients reporting within interval" icon={Wifi} tone="blue" />
        <MetricCard label="Protected software" value={summary?.protectedSoftware ?? '—'} detail="active enforcement policies" icon={ShieldCheck} tone="amber" />
        <MetricCard label="Syncs today" value={summary?.syncsToday ?? '—'} detail={summary?.latestSync ? `last sync ${relativeTime(summary.latestSync)}` : 'No sync recorded'} icon={Activity} tone="slate" trend="up" />
      </section>
        <section data-testid="panel-application-update-mode" className="mt-6 rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><h2 className="text-sm font-extrabold text-[#284139]">Application Update Mode</h2><StatusPill value={policies.some((policy) => policy.updateMode) ? 'configured' : 'standby'} kind={policies.some((policy) => policy.updateMode) ? 'success' : 'neutral'} /></div><p className="mt-1 text-xs text-[#87958e]">Update Mode is configured independently on each software policy, with its own close timeout.</p></div><Link href="/software" className="text-xs font-bold text-[#277657] hover:text-[#174f3a]">Manage application policies <ChevronRight className="ml-1 inline" size={14} /></Link></div><div className="mt-4 flex flex-wrap gap-2">{policies.filter((policy) => policy.updateMode).length === 0 ? <span className="text-[11px] text-[#87958e]">No application currently uses Update Mode.</span> : policies.filter((policy) => policy.updateMode).map((policy) => <span key={policy.id} className="rounded-full border border-[#b8dfc8] bg-[#dff2e9] px-2.5 py-1 text-[10px] font-bold text-[#176244]">{policy.name} · {policy.updateModeCloseTimeoutSeconds ?? 8}s</span>)}</div></section>
       <section className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_.9fr]">
        <div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]">
          <div className="flex items-center justify-between border-b border-[#e5ebe5] px-5 py-4"><div><h2 className="text-sm font-extrabold text-[#284139]">Recent synchronization</h2><p className="mt-1 text-xs text-[#87958e]">The latest client check-ins across your estate</p></div><Link href="/audit" data-testid="link-view-audit" className="text-xs font-bold text-[#277657] hover:text-[#174f3a]">View audit trail <ChevronRight className="ml-1 inline" size={14} /></Link></div>
          {audits.length === 0 ? <div className="p-5"><EmptyState icon={Activity} title="No synchronization history" detail="Once a client reports in, its result will appear here." /></div> : <div className="divide-y divide-[#edf0eb]">{audits.map((entry) => <AuditRow key={entry.id} entry={entry} compact />)}</div>}
        </div>
        <div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]">
          <div className="border-b border-[#e5ebe5] px-5 py-4"><h2 className="text-sm font-extrabold text-[#284139]">Attention items</h2><p className="mt-1 text-xs text-[#87958e]">Signals that may affect enforcement</p></div>
           {attention.length === 0 ? <div className="p-5"><div className="flex flex-col items-center justify-center py-9 text-center"><div className="mb-3 rounded-full bg-[#dff2e9] p-3 text-[#247455]"><Check size={22} /></div><div className="text-sm font-bold text-[#315247]">Estate looks healthy</div><p className="mt-1 text-xs text-[#82918a]">No client access or connectivity issues detected.</p></div></div> : <div className="divide-y divide-[#edf0eb]">{attention.slice(0, 5).map((client) => <Link href="/clients" key={client.id} data-testid={`link-attention-${client.id}`} className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[#f8faf5]"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fff0d5] text-[#94661a]"><AlertTriangle size={15} /></div><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold text-[#38504b]">{client.hostname}</div><div className="mt-1 text-[11px] text-[#8a9791]">Last sync {relativeTime(client.lastSync)} · {client.status} client access</div></div><ChevronRight size={15} className="text-[#a9b6af]" /></Link>)}</div>}
        </div>
      </section>
      <section className="mt-6 rounded-xl border border-[#dbe3dd] bg-[#203c4a] p-5 text-[#eaf3ed] shadow-[0_6px_24px_rgba(29,55,63,.1)] md:p-6">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center"><div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8ec5ad]"><Server size={13} /> Policy posture</div><h2 className="mt-2 text-xl font-extrabold tracking-tight">Enforcement is ready for the next wave.</h2><p className="mt-1 max-w-xl text-xs leading-5 text-[#a9c0ba]">{policies.filter((p) => p.enabled).length} active policies are queued for client evaluation. {policies.filter((p) => !p.enabled).length} policies are currently paused.</p></div><Link href="/software" data-testid="link-manage-policies" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#a7e4c5] px-4 text-xs font-extrabold text-[#173c31] transition hover:bg-[#c0efd5]">Manage policies <ChevronRight size={15} /></Link></div>
      </section>
    </>}
  </div>;
}

function AuditRow({ entry, compact = false }: { entry: AuditEntry; compact?: boolean }) {
  const kind = entry.result === 'success' ? 'success' : entry.result === 'warning' ? 'warning' : 'danger';
  return <div className={cx('flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[#fafbf7]', compact ? '' : 'min-w-[680px]')}><div className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', kind === 'success' ? 'bg-[#dff2e9] text-[#277657]' : kind === 'warning' ? 'bg-[#fff0d5] text-[#94661a]' : 'bg-[#f9e1dd] text-[#a13a31]')}>{kind === 'success' ? <Check size={15} /> : kind === 'warning' ? <AlertTriangle size={15} /> : <Ban size={15} />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold text-[#365049]">{entry.clientName}</div><div className="mt-1 font-mono text-[10px] text-[#8a9891]">{formatTime(entry.timestamp)} <span className="mx-1 text-[#bbc5bd]">/</span> {entry.applications.length} app{entry.applications.length === 1 ? '' : 's'} evaluated</div></div><StatusPill value={entry.result} kind={kind} /></div>;
}

function ClientsPage() {
  const query = useListClients();
  const revoke = useRevokeClient();
  const clientList = query.data ?? [];
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Client | null>(null);
  const filtered = clientList.filter((client) => `${client.name} ${client.hostname} ${client.address}`.toLowerCase().includes(search.toLowerCase()));
  const clientId = useMemo(() => selected?.id ?? '', [selected?.id]);
  const config = useGetClientSyncConfig(clientId, { query: { enabled: Boolean(selected), queryKey: getGetClientSyncConfigQueryKey(clientId) } });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
  const revokeClient = (client: Client) => { if (window.confirm(`Deactivate client access for ${client.hostname}?`)) revoke.mutate({ id: client.id }, { onSuccess: invalidate }); };
  return <div className="mx-auto max-w-[1380px]">
    <PageHeader eyebrow="Estate inventory" title="Clients" detail="Every enrolled Windows service, identified by hostname, with its latest signal and access state." action={<Button onClick={() => query.refetch()} variant="secondary" disabled={query.isFetching} data-testid="button-refresh-clients"><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} /> Refresh</Button>} />
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#91a09b]" /><input aria-label="Search clients" data-testid="input-search-clients" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, hostname, or address" className="h-9 w-full rounded-lg border border-[#d9e1db] bg-[#fbfcf8] pl-9 pr-3 text-xs text-[#284139] outline-none placeholder:text-[#9ba8a1] focus:border-[#75ad95] focus:ring-2 focus:ring-[#4ca27a]/15" /></div><div className="flex items-center gap-2 text-[11px] font-bold text-[#71817c]"><span className="font-mono text-[#2c785b]">{clientList.length}</span> enrolled <span className="mx-1 h-3 w-px bg-[#d3ddd6]" /><span className="font-mono text-[#2c785b]">{clientList.filter((c) => c.status === 'online').length}</span> online</div></div>
    {query.isError ? <ErrorState onRetry={() => query.refetch()} /> : query.isLoading ? <LoadingRows count={6} /> : filtered.length === 0 ? <EmptyState icon={Laptop} title={search ? 'No matching clients' : 'No clients enrolled'} detail={search ? 'Try a hostname, address, or a shorter name.' : 'Enroll a Windows service to begin receiving synchronization reports.'} action={search ? <Button variant="secondary" onClick={() => setSearch('')}>Clear search</Button> : undefined} /> : <div className="overflow-hidden rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="hidden grid-cols-[1.4fr_1fr_.85fr_100px] gap-4 border-b border-[#e5ebe5] bg-[#f8faf6] px-5 py-3 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#87958e] md:grid"><span>Hostname</span><span>Network address</span><span>Last sync</span><span /></div><div className="divide-y divide-[#edf0eb]">{filtered.map((client) => <div key={client.id} data-testid={`row-client-${client.id}`} className="grid gap-3 px-5 py-4 transition-colors hover:bg-[#fafbf7] md:grid-cols-[1.4fr_1fr_.85fr_100px] md:items-center md:gap-4"><button data-testid={`button-client-details-${client.id}`} onClick={() => setSelected(client)} className="flex min-w-0 items-center gap-3 text-left"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e3f0e9] text-[11px] font-extrabold text-[#2d7258]">{initials(client.hostname)}</div><div className="min-w-0"><div data-testid={`text-client-hostname-${client.id}`} className="truncate text-xs font-extrabold text-[#304b45]">{client.hostname}</div><div className="mt-1 truncate font-mono text-[10px] text-[#899992]">{client.name} <span className="text-[#b4c1b9]">·</span> v{client.syncVersion}</div></div></button><div className="font-mono text-[11px] text-[#536b68]">{client.address}</div><div><span className="text-xs font-semibold text-[#536b68]">{relativeTime(client.lastSync)}</span><div className="mt-1 text-[10px] text-[#9aa7a0]">{formatTime(client.lastSync)}</div></div><div className="flex items-center justify-end gap-1"><StatusPill value={client.status === 'online' ? 'access active' : client.status} kind={client.status === 'online' ? 'online' : client.status === 'stale' ? 'warning' : 'danger'} /><button aria-label={`Inspect ${client.hostname}`} data-testid={`button-inspect-client-${client.id}`} onClick={() => setSelected(client)} className="rounded-md p-2 text-[#79908a] hover:bg-[#e4eee8] hover:text-[#246d53]"><ChevronRight size={16} /></button><button aria-label={`Deactivate access for ${client.hostname}`} data-testid={`button-deactivate-client-${client.id}`} disabled={client.status === 'revoked' || revoke.isPending} onClick={() => revokeClient(client)} className="rounded-md p-2 text-[#9b7972] hover:bg-[#f9e3df] hover:text-[#a13a31]"><ShieldX size={15} /></button></div></div>)}</div></div>}
    {selected && <ClientModal client={selected} config={config.data} loading={config.isLoading} onClose={() => setSelected(null)} onRevoke={() => revokeClient(selected)} />}
  </div>;
}

function ClientModal({ client, config, loading, onClose, onRevoke }: { client: Client; config?: SyncConfig; loading: boolean; onClose: () => void; onRevoke: () => void }) {
  return <Modal title="Client inspection" subtitle={`${client.name} · ${client.hostname}`} onClose={onClose}>
    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg bg-[#f5f8f3] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Client access</div><div className="mt-2"><StatusPill value={client.status === 'online' ? 'active' : client.status} kind={client.status === 'online' ? 'online' : client.status === 'stale' ? 'warning' : 'danger'} /></div></div><div data-testid={`text-inspected-hostname-${client.id}`} className="rounded-lg bg-[#f5f8f3] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Hostname identity</div><div className="mt-2 font-mono text-xs font-bold text-[#39514d]">{client.hostname}</div><div className="mt-1 text-[10px] text-[#87958e]">Shared API-key transport</div></div></div>
    <div className="mt-5 grid gap-4 border-y border-[#e6ece6] py-4 sm:grid-cols-2"><div><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Address</div><div className="mt-1 font-mono text-xs text-[#39514d]">{client.address}</div></div><div><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Last sync</div><div className="mt-1 text-xs text-[#39514d]">{formatTime(client.lastSync)}</div></div></div>
    <div className="rounded-lg border border-[#dbe3dd] p-4"><div className="flex items-center justify-between"><div><div className="text-xs font-extrabold text-[#365049]">Effective sync configuration</div><div className="mt-1 text-[11px] text-[#87958e]">What this client will receive next</div></div><Code2 size={17} className="text-[#729087]" /></div>{loading ? <div className="mt-4 h-12 animate-pulse rounded bg-[#edf2ed]" /> : config ? <div className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><span className="text-[#87958e]">Interval</span><div className="mt-1 font-mono text-[#39514d]">{config.syncIntervalSeconds}s</div></div><div><span className="text-[#87958e]">Mode</span><div className="mt-1 font-mono text-[#39514d]">{config.updateMode ? 'Update Mode' : 'Normal'}</div></div><div><span className="text-[#87958e]">Close timeout</span><div className="mt-1 font-mono text-[#39514d]">{config.closeOnStartTimeoutSeconds}s</div></div><div><span className="text-[#87958e]">Config version</span><div className="mt-1 truncate font-mono text-[#39514d]">{config.configVersion}</div></div><div className="col-span-2"><span className="text-[#87958e]">Policies</span><div className="mt-1 font-mono text-[#39514d]">{config.policies.length} effective</div></div></div> : <p className="mt-4 text-xs text-[#a06b62]">Effective configuration is unavailable.</p>}</div>
    <div className="mt-5 flex justify-between gap-2"><Button variant="danger" onClick={onRevoke} disabled={client.status === 'revoked'}><ShieldX size={14} /> Deactivate access</Button><Button variant="secondary" onClick={onClose}>Close</Button></div>
  </Modal>;
}

function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#10242c]/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"><div className={cx('max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-[#d2ddd5] bg-[#fffdf8] p-5 shadow-[0_18px_70px_rgba(19,43,50,.2)] sm:rounded-2xl sm:p-6', wide ? 'max-w-2xl' : 'max-w-lg')}><div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-lg font-extrabold tracking-tight text-[#284139]">{title}</h2>{subtitle && <p className="mt-1 text-xs text-[#87958e]">{subtitle}</p>}</div><button aria-label="Close dialog" data-testid="button-close-dialog" onClick={onClose} className="rounded-lg p-1.5 text-[#7d9189] hover:bg-[#e8efea]"><X size={18} /></button></div>{children}</div></div>;
}

function SoftwarePage() {
  const query = useListSoftware();
  const [editor, setEditor] = useState<{ open: boolean; policy?: SoftwarePolicy }>({ open: false });
  const [search, setSearch] = useState('');
  const policies = (query.data ?? []).filter((policy) => `${policy.name} ${policy.executable}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="mx-auto max-w-[1380px]">
    <PageHeader eyebrow="Enforcement registry" title="Software policies" detail="Version rules are evaluated on the client. Keep executable paths, INI expectations, and grace windows explicit." action={<Button onClick={() => setEditor({ open: true })} data-testid="button-new-policy"><Plus size={15} /> New policy</Button>} />
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#91a09b]" /><input aria-label="Search policies" data-testid="input-search-policies" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search policy or executable" className="h-9 w-full rounded-lg border border-[#d9e1db] bg-[#fffdf8] pl-9 pr-3 text-xs outline-none placeholder:text-[#9ba8a1] focus:border-[#75ad95] focus:ring-2 focus:ring-[#4ca27a]/15" /></div><div className="flex items-center gap-2 text-[11px] font-bold text-[#71817c]"><span className="font-mono text-[#2c785b]">{(query.data ?? []).filter((p) => p.enabled).length}</span> active policies</div></div>
    {query.isError ? <ErrorState onRetry={() => query.refetch()} /> : query.isLoading ? <LoadingRows count={5} /> : policies.length === 0 ? <EmptyState icon={FileCog} title={search ? 'No matching policies' : 'No software policies'} detail={search ? 'Try a shorter name or executable path.' : 'Create a policy to define the versions clients must run.'} action={!search ? <Button onClick={() => setEditor({ open: true })}><Plus size={14} /> Create first policy</Button> : <Button variant="secondary" onClick={() => setSearch('')}>Clear search</Button>} /> : <div className="grid gap-4 lg:grid-cols-2">{policies.map((policy) => <PolicyCard key={policy.id} policy={policy} onEdit={() => setEditor({ open: true, policy })} />)}</div>}
    {editor.open && <PolicyEditor policy={editor.policy} onClose={() => setEditor({ open: false })} />}
  </div>;
}

function PolicyCard({ policy, onEdit }: { policy: SoftwarePolicy; onEdit: () => void }) {
  const exeCount = policy.exeChecks.length;
  const iniCount = policy.iniChecks.length;
  return <div data-testid={`card-policy-${policy.id}`} className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#b7cec1]"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><div className={cx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', policy.ruleType === 'ini' ? 'bg-[#e0eef1] text-[#286b76]' : 'bg-[#dff2e9] text-[#247455]')}>{policy.ruleType === 'ini' ? <FileKey2 size={18} /> : <HardDrive size={18} />}</div><div className="min-w-0"><h2 className="truncate text-sm font-extrabold text-[#2d4942]">{policy.name}</h2><div className="mt-1 truncate font-mono text-[10px] text-[#8a9992]">{policy.ruleType === 'application' ? 'Application-level checks' : policy.executable}</div></div></div><button aria-label={`Edit ${policy.name}`} data-testid={`button-edit-policy-${policy.id}`} onClick={onEdit} className="rounded-lg p-2 text-[#79908a] hover:bg-[#e5eee8] hover:text-[#246d53]"><Pencil size={15} /></button></div><div className="mt-5 grid grid-cols-2 gap-3 border-y border-[#e7ece7] py-3"><div><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#96a39d]">Checks</div><div className="mt-1 font-mono text-xs font-medium text-[#315049]">{exeCount} EXE · {iniCount} INI</div></div><div><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#96a39d]">Rule type</div><div className="mt-1 text-xs font-bold text-[#315049]">{policy.ruleType === 'application' ? 'Application' : policy.ruleType === 'ini' ? 'INI value' : 'EXE version'}</div></div></div><div className="flex items-center justify-between"><div className="flex items-center gap-2"><StatusPill value={policy.enabled ? 'enforcing' : 'paused'} kind={policy.enabled ? 'success' : 'neutral'} /><span className="text-[11px] text-[#87958e]">{policy.graceSeconds}s grace</span></div><span className="font-mono text-[10px] text-[#9aa7a0]">updated {relativeTime(policy.lastUpdated)}</span></div>{(iniCount > 0 || policy.ruleType === 'ini') && <div className="mt-4 flex items-center gap-2 rounded-lg bg-[#f5f8f3] px-3 py-2 text-[11px] text-[#71817c]"><Code2 size={13} className="text-[#4b9474]" />{iniCount} expected INI value{iniCount === 1 ? '' : 's'}<span className="ml-auto font-mono text-[#4d7165]">{policy.iniChecks.map((rule) => `[${rule.section}]`).join(' ')}</span></div>}</div>;
}

function PolicyEditor({ policy, onClose }: { policy?: SoftwarePolicy; onClose: () => void }) {
  const isEdit = Boolean(policy);
  const create = useCreateSoftware();
  const update = useUpdateSoftware();
  const [name, setName] = useState(policy?.name ?? '');
  const [executable, setExecutable] = useState(policy?.executable ?? '');
  const [targetVersion, setTargetVersion] = useState(policy?.targetVersion ?? '');
  const [ruleType, setRuleType] = useState<'application' | 'file-version' | 'ini'>(policy?.ruleType ?? 'application');
  const [graceSeconds, setGraceSeconds] = useState(String(policy?.graceSeconds ?? 300));
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [updateMode, setUpdateMode] = useState(policy?.updateMode ?? false);
  const [updateModeCloseTimeoutSeconds, setUpdateModeCloseTimeoutSeconds] = useState(String(policy?.updateModeCloseTimeoutSeconds ?? 8));
  const [rules, setRules] = useState<IniRule[]>(policy?.iniRules ?? [{ section: 'Settings', key: '', expectedValue: '' }]);
  const [exeChecks, setExeChecks] = useState<ExeCheck[]>(policy?.exeChecks.length ? policy.exeChecks : [{ executable: '', targetVersion: '', installCommand: '' }]);
  const [iniChecks, setIniChecks] = useState<IniCheck[]>(policy?.iniChecks.length ? policy.iniChecks : [{ filePath: '', section: 'Poste', key: '', expectedValue: '' }]);
  const [feedback, setFeedback] = useState('');
  const busy = create.isPending || update.isPending;
  const updateRule = (index: number, field: keyof IniRule, value: string) => setRules((items) => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  const updateExeCheck = (index: number, field: keyof ExeCheck, value: string) => setExeChecks((items) => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  const updateIniCheck = (index: number, field: keyof IniCheck, value: string) => setIniChecks((items) => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  const submit = (event: FormEvent) => { event.preventDefault(); const validExeChecks = exeChecks.filter((check) => check.executable.trim() && check.targetVersion.trim()).map((check) => ({ ...check, executable: check.executable.trim(), targetVersion: check.targetVersion.trim() })); const validIniChecks = iniChecks.filter((check) => check.filePath.trim() && check.section.trim() && check.key.trim()).map((check) => ({ ...check, filePath: check.filePath.trim(), section: check.section.trim(), key: check.key.trim(), expectedValue: check.expectedValue.trim() })); const data: SoftwarePolicyInput = { name: name.trim(), executable: ruleType === 'application' ? validExeChecks[0]?.executable : executable.trim(), targetVersion: ruleType === 'application' ? validExeChecks[0]?.targetVersion : targetVersion.trim(), ruleType, graceSeconds: Number(graceSeconds), updateMode, updateModeCloseTimeoutSeconds: Number(updateModeCloseTimeoutSeconds), enabled, exeChecks: ruleType === 'application' ? validExeChecks : [], iniChecks: ruleType === 'application' ? validIniChecks : [], iniRules: ruleType === 'ini' ? rules.filter((rule) => rule.section && rule.key) : [] }; if (!data.name || (ruleType === 'application' && validExeChecks.length === 0 && validIniChecks.length === 0) || (ruleType !== 'application' && (!data.executable || !data.targetVersion))) { setFeedback(ruleType === 'application' ? 'Add at least one complete EXE or INI check.' : 'Name, executable, and expected version are required.'); return; } const onSuccess = () => { queryClient.invalidateQueries({ queryKey: getListSoftwareQueryKey() }); onClose(); }; if (isEdit && policy) update.mutate({ id: policy.id, data }, { onSuccess }); else create.mutate({ data }, { onSuccess }); };
  return <Modal wide title={isEdit ? 'Edit policy' : 'New software policy'} subtitle={isEdit ? `Update ${policy?.name}` : 'Define a version expectation for enrolled clients.'} onClose={onClose}><form onSubmit={submit} className="space-y-4">
     <div className="grid gap-4 sm:grid-cols-2"><label className="block sm:col-span-2"><span className="field-label">Application name</span><input autoFocus required data-testid="input-policy-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SecureConnect Agent" className="field-input" /></label>{ruleType !== 'application' && <><label className="block"><span className="field-label">Executable path</span><input required data-testid="input-policy-executable" value={executable} onChange={(e) => setExecutable(e.target.value)} placeholder="C:\Program Files\...\agent.exe" className="field-input font-mono" /></label><label className="block"><span className="field-label">Target version</span><input required data-testid="input-policy-version" value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)} placeholder="4.7.2.118" className="field-input font-mono" /></label></>}</div>
     <div><span className="field-label">Evaluation rule</span><div className="grid gap-2 sm:grid-cols-3"><button type="button" data-testid="button-rule-application" onClick={() => setRuleType('application')} className={cx('rounded-lg border p-3 text-left transition', ruleType === 'application' ? 'border-[#5fa886] bg-[#e8f4ed]' : 'border-[#d9e2dc] bg-[#fbfcf8] hover:bg-[#f2f7f2]')}><div className="flex items-center gap-2 text-xs font-bold text-[#35534a]"><Settings2 size={15} /> Application checks</div><div className="mt-1 text-[10px] text-[#87958e]">Group EXE and INI rules</div></button><button type="button" data-testid="button-rule-file-version" onClick={() => setRuleType('file-version')} className={cx('rounded-lg border p-3 text-left transition', ruleType === 'file-version' ? 'border-[#5fa886] bg-[#e8f4ed]' : 'border-[#d9e2dc] bg-[#fbfcf8] hover:bg-[#f2f7f2]')}><div className="flex items-center gap-2 text-xs font-bold text-[#35534a]"><HardDrive size={15} /> File version</div><div className="mt-1 text-[10px] text-[#87958e]">Read one EXE metadata value</div></button><button type="button" data-testid="button-rule-ini" onClick={() => setRuleType('ini')} className={cx('rounded-lg border p-3 text-left transition', ruleType === 'ini' ? 'border-[#5fa886] bg-[#e8f4ed]' : 'border-[#d9e2dc] bg-[#fbfcf8] hover:bg-[#f2f7f2]')}><div className="flex items-center gap-2 text-xs font-bold text-[#35534a]"><FileKey2 size={15} /> INI values</div><div className="mt-1 text-[10px] text-[#87958e]">Match section and key values</div></button></div></div>
     {ruleType === 'application' && <div className="space-y-4 rounded-lg border border-[#dbe5dd] bg-[#f8faf6] p-3"><div><div className="mb-2 flex items-center justify-between"><div><div className="text-xs font-extrabold text-[#38534a]">EXE checks</div><div className="text-[10px] text-[#8b9992]">Every EXE check is evaluated; install commands run silently when a version is out of policy.</div></div><Button type="button" variant="secondary" onClick={() => setExeChecks((items) => [...items, { executable: '', targetVersion: '', installCommand: '' }])} data-testid="button-add-exe-check"><Plus size={13} /> Add EXE</Button></div>{exeChecks.map((check, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1.1fr_.65fr_1fr_28px]"><input aria-label={`EXE path ${index + 1}`} data-testid={`input-exe-path-${index}`} value={check.executable} onChange={(e) => updateExeCheck(index, 'executable', e.target.value)} placeholder="C:\Program Files\...\agent.exe" className="field-input font-mono" /><input aria-label={`EXE target version ${index + 1}`} data-testid={`input-exe-version-${index}`} value={check.targetVersion} onChange={(e) => updateExeCheck(index, 'targetVersion', e.target.value)} placeholder="4.7.2.118" className="field-input font-mono" /><input aria-label={`EXE install command ${index + 1}`} data-testid={`input-exe-install-command-${index}`} value={check.installCommand ?? ''} onChange={(e) => updateExeCheck(index, 'installCommand', e.target.value)} placeholder="Setup.exe /quiet" className="field-input font-mono" /><button type="button" aria-label={`Remove EXE check ${index + 1}`} data-testid={`button-remove-exe-${index}`} onClick={() => setExeChecks((items) => items.filter((_, i) => i !== index))} className="rounded-md text-[#9a817a] hover:bg-[#f9e3df] hover:text-[#a13a31]"><Trash2 size={14} /></button></div>)}</div><div><div className="mb-2 flex items-center justify-between"><div><div className="text-xs font-extrabold text-[#38534a]">INI checks</div><div className="text-[10px] text-[#8b9992]">All configured section/key/value rows must match.</div></div><Button type="button" variant="secondary" onClick={() => setIniChecks((items) => [...items, { filePath: '', section: 'Poste', key: '', expectedValue: '' }])} data-testid="button-add-application-ini"><Plus size={13} /> Add INI</Button></div>{iniChecks.map((check, index) => <div key={index} className="mb-2 grid gap-2 sm:grid-cols-[1.1fr_.65fr_.75fr_.75fr_28px]"><input aria-label={`INI file ${index + 1}`} data-testid={`input-application-ini-file-${index}`} value={check.filePath} onChange={(e) => updateIniCheck(index, 'filePath', e.target.value)} placeholder="C:\ProgramData\app.ini" className="field-input font-mono" /><input aria-label={`Application INI section ${index + 1}`} value={check.section} onChange={(e) => updateIniCheck(index, 'section', e.target.value)} placeholder="Section" className="field-input font-mono" /><input aria-label={`Application INI key ${index + 1}`} value={check.key} onChange={(e) => updateIniCheck(index, 'key', e.target.value)} placeholder="Key" className="field-input font-mono" /><input aria-label={`Application INI expected value ${index + 1}`} value={check.expectedValue} onChange={(e) => updateIniCheck(index, 'expectedValue', e.target.value)} placeholder="Expected value" className="field-input font-mono" /><button type="button" aria-label={`Remove application INI check ${index + 1}`} data-testid={`button-remove-application-ini-${index}`} onClick={() => setIniChecks((items) => items.filter((_, i) => i !== index))} className="rounded-md text-[#9a817a] hover:bg-[#f9e3df] hover:text-[#a13a31]"><Trash2 size={14} /></button></div>)}</div></div>}
     {ruleType === 'ini' && <div className="rounded-lg border border-[#dbe5dd] bg-[#f8faf6] p-3"><div className="mb-2 flex items-center justify-between"><div><div className="text-xs font-extrabold text-[#38534a]">Expected INI values</div><div className="text-[10px] text-[#8b9992]">All rows must match before the client is compliant.</div></div><Button type="button" variant="secondary" onClick={() => setRules((items) => [...items, { section: 'Settings', key: '', expectedValue: '' }])} data-testid="button-add-ini-rule"><Plus size={13} /> Add row</Button></div>{rules.map((rule, index) => <div key={index} className="mb-2 grid grid-cols-[.8fr_1fr_1fr_28px] gap-2"><input aria-label={`INI section ${index + 1}`} data-testid={`input-ini-section-${index}`} value={rule.section} onChange={(e) => updateRule(index, 'section', e.target.value)} placeholder="Section" className="field-input font-mono" /><input aria-label={`INI key ${index + 1}`} data-testid={`input-ini-key-${index}`} value={rule.key} onChange={(e) => updateRule(index, 'key', e.target.value)} placeholder="Key" className="field-input font-mono" /><input aria-label={`INI expected value ${index + 1}`} data-testid={`input-ini-value-${index}`} value={rule.expectedValue} onChange={(e) => updateRule(index, 'expectedValue', e.target.value)} placeholder="Expected value" className="field-input font-mono" /><button type="button" aria-label={`Remove INI row ${index + 1}`} data-testid={`button-remove-ini-${index}`} disabled={rules.length === 1} onClick={() => setRules((items) => items.filter((_, i) => i !== index))} className="rounded-md text-[#9a817a] hover:bg-[#f9e3df] hover:text-[#a13a31]"><Trash2 size={14} /></button></div>)}</div>}
     <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="block"><span className="field-label">Grace period (seconds)</span><input type="number" min="0" max="3600" required data-testid="input-policy-grace" value={graceSeconds} onChange={(e) => setGraceSeconds(e.target.value)} className="field-input font-mono" /></label><div><span className="field-label">Policy state</span><button type="button" data-testid="button-toggle-policy-state" onClick={() => setEnabled((value) => !value)} className={cx('flex h-9 w-full items-center justify-between rounded-lg border px-3 text-xs font-bold transition sm:w-[150px]', enabled ? 'border-[#8cc5a6] bg-[#e7f4ec] text-[#267154]' : 'border-[#d6ded8] bg-[#eef1ef] text-[#72817b]')}><span>{enabled ? 'Enforcing' : 'Paused'}</span><span className={cx('h-2 w-2 rounded-full', enabled ? 'bg-[#2ca06d]' : 'bg-[#96a29d]')} /></button></div></div>
     <section className="rounded-lg border border-[#dbe5dd] bg-[#f8faf6] p-3"><SettingToggle label="Application Update Mode" detail="Only this application's managed processes use the short close timeout." value={updateMode} onChange={setUpdateMode} testId="toggle-policy-update-mode" /><label className="mt-3 block max-w-[220px]"><span className="field-label">Close timeout in Update Mode (seconds)</span><input type="number" min="1" max="300" required value={updateModeCloseTimeoutSeconds} onChange={(event) => setUpdateModeCloseTimeoutSeconds(event.target.value)} className="field-input font-mono" /></label></section>
    {feedback && <div className="rounded-lg bg-[#fff0d5] px-3 py-2 text-xs font-semibold text-[#8a5a08]">{feedback}</div>}<div className="flex justify-end gap-2 border-t border-[#e7ece7] pt-4"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}><Save size={14} />{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create policy'}</Button></div>
  </form></Modal>;
}

function AuditPage() {
  const query = useListAuditEntries({ limit: 100 });
  const clientsQuery = useListClients();
  const submit = useSubmitSyncReport();
  const [showReport, setShowReport] = useState(false);
  return <div className="mx-auto max-w-[1380px]">
    <PageHeader eyebrow="Evidence log" title="Audit trail" detail="A durable record of synchronization outcomes, observed application versions, and policy expectations." action={<div className="flex gap-2"><Button variant="secondary" onClick={() => query.refetch()} disabled={query.isFetching} data-testid="button-refresh-audit"><RefreshCw size={14} /> Refresh</Button><Button onClick={() => setShowReport(true)} data-testid="button-record-report"><Plus size={15} /> Record report</Button></div>} />
    {query.isError ? <ErrorState onRetry={() => query.refetch()} /> : query.isLoading ? <LoadingRows count={7} /> : (query.data ?? []).length === 0 ? <EmptyState icon={Archive} title="No audit entries yet" detail="Synchronization results will be retained here as clients check in." action={<Button variant="secondary" onClick={() => setShowReport(true)}><Plus size={14} /> Record a report</Button>} /> : <div className="overflow-x-auto rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="hidden min-w-[900px] grid-cols-[1.1fr_.8fr_1fr_1fr] gap-4 border-b border-[#e5ebe5] bg-[#f8faf6] px-5 py-3 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#87958e] md:grid"><span>Client</span><span>Timestamp</span><span>Result</span><span>Applications</span></div><div className="min-w-[760px] divide-y divide-[#edf0eb]">{(query.data ?? []).map((entry) => <AuditDetailRow key={entry.id} entry={entry} />)}</div></div>}
    {showReport && <ReportModal clients={clientsQuery.data ?? []} onClose={() => setShowReport(false)} mutation={submit} />}
  </div>;
}

function AuditDetailRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const kind = entry.result === 'success' ? 'success' : entry.result === 'warning' ? 'warning' : 'danger';
  return <div className="group"><button data-testid={`button-expand-audit-${entry.id}`} onClick={() => setExpanded((value) => !value)} className="grid w-full grid-cols-[1.1fr_.8fr_1fr_1fr] gap-4 px-5 py-4 text-left transition hover:bg-[#fafbf7]"><div className="flex items-center gap-2 text-xs font-bold text-[#365049]"><ChevronRight size={14} className={cx('text-[#9baaa2] transition-transform', expanded && 'rotate-90')} />{entry.clientName}</div><div className="font-mono text-[10px] text-[#71817c]">{formatTime(entry.timestamp)}</div><div><StatusPill value={entry.result} kind={kind} /></div><div className="text-xs text-[#536b68]">{entry.applications.filter((app) => app.compliant).length}/{entry.applications.length} compliant</div></button>{expanded && <div className="grid gap-2 bg-[#f6f9f5] px-12 py-3">{entry.applications.length === 0 ? <div className="text-xs text-[#87958e]">No application details attached to this report.</div> : entry.applications.map((app) => <div key={app.softwareId} className="grid grid-cols-[1.4fr_1fr_1fr_90px] items-center gap-3 text-xs"><span className="font-semibold text-[#486159]">{app.softwareName}</span><span className="font-mono text-[10px] text-[#71817c]">observed {app.observedVersion}</span><span className="font-mono text-[10px] text-[#71817c]">expected {app.expectedVersion}</span><StatusPill value={app.compliant ? 'match' : 'drift'} kind={app.compliant ? 'success' : 'danger'} /></div>)}</div>}</div>;
}

function ReportModal({ clients, onClose, mutation }: { clients: Client[]; onClose: () => void; mutation: ReturnType<typeof useSubmitSyncReport> }) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [result, setResult] = useState<'success' | 'warning' | 'rejected'>('success');
  const client = clients.find((item) => item.id === clientId);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!client) return; mutation.mutate({ data: { clientId: client.id, clientName: client.name, result, applications: [] } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListAuditEntriesQueryKey({ limit: 100 }) }); onClose(); } }); };
  return <Modal title="Record synchronization report" subtitle="Attach a result to a client for operational traceability." onClose={onClose}><form onSubmit={submit} className="space-y-4"><label className="block"><span className="field-label">Client</span><select required data-testid="select-report-client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="field-input">{clients.length === 0 ? <option value="">No clients available</option> : clients.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.hostname}</option>)}</select></label><label className="block"><span className="field-label">Observed result</span><select data-testid="select-report-result" value={result} onChange={(e) => setResult(e.target.value as typeof result)} className="field-input"><option value="success">Success — all policies satisfied</option><option value="warning">Warning — drift observed</option><option value="rejected">Rejected — client not trusted</option></select></label><div className="rounded-lg bg-[#f5f8f3] p-3 text-xs leading-5 text-[#71817c]"><CircleHelp size={14} className="mr-1 inline text-[#4b9474]" /> This records the sync outcome now. Detailed application observations are attached by the Windows service during its next report.</div><div className="flex justify-end gap-2 border-t border-[#e7ece7] pt-4"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!client || mutation.isPending}><Save size={14} />{mutation.isPending ? 'Recording…' : 'Record result'}</Button></div></form></Modal>;
}

function AdminPasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Unable to change password.');
      setCurrentPassword('');
      setNewPassword('');
      setFeedback('Password changed.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to change password.');
    } finally {
      setBusy(false);
    }
  };
  return <details className="group w-full max-w-sm rounded-lg border border-[#dbe3dd] bg-[#fffdf8] p-2.5 text-left"><summary className="cursor-pointer list-none px-1 text-xs font-bold text-[#38534a]">Change administrator password</summary><form onSubmit={changePassword} className="mt-3 space-y-2.5 border-t border-[#e7ece7] pt-3"><label className="block"><span className="field-label">Current password</span><input required autoComplete="current-password" type="password" data-testid="input-current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="field-input" /></label><label className="block"><span className="field-label">New password</span><input required minLength={8} autoComplete="new-password" type="password" data-testid="input-new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="field-input" /></label><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-[#87958e]">Minimum 8 characters.</span><Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Changing…' : 'Change'}</Button></div>{feedback && <div role="status" data-testid="text-password-feedback" className="text-[10px] font-semibold text-[#4d7165]">{feedback}</div>}</form></details>;
}

function AdministratorsPage() {
  const [users, setUsers] = useState<AdministratorUser[]>([]);
  const [username, setUsername] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/users', { credentials: 'include' });
      if (!response.ok) throw new Error('Unable to load administrators.');
      setUsers(await response.json() as AdministratorUser[]);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load administrators.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    try {
      const response = await fetch('/api/users', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim() }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Unable to add administrator.');
      setUsers((items) => [body as AdministratorUser, ...items]);
      setUsername('');
      setFeedback('Administrator added. They can sign in with their LDAP password.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to add administrator.');
    } finally {
      setBusy(false);
    }
  };
  const changeActive = async (user: AdministratorUser) => {
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !user.isActive }) });
    if (response.ok) setUsers((items) => items.map((item) => item.id === user.id ? { ...item, isActive: !user.isActive } : item));
  };
  const remove = async (user: AdministratorUser) => {
    if (!window.confirm(`Remove ${user.username} from administrators?`)) return;
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', credentials: 'include' });
    if (response.ok) setUsers((items) => items.filter((item) => item.id !== user.id));
  };
  return <div className="mx-auto max-w-[1080px]">
    <PageHeader eyebrow="Access control" title="Administrators" detail="Only listed LDAP users can enter the control center. Every administrator has the same unrestricted administrator role." action={<Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Refresh</Button>} />
    <div className="grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><Users size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Add LDAP administrator</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">The account is looked up through the configured directory before it is granted access.</p></div></div><form onSubmit={add} className="space-y-3"><label className="block"><span className="field-label">LDAP username</span><input required data-testid="input-admin-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="jdupont" className="field-input" /></label><Button type="submit" disabled={busy || !username.trim()}><Plus size={14} />{busy ? 'Looking up…' : 'Add administrator'}</Button>{feedback && <div role="status" className="rounded-lg bg-[#f5f8f3] px-3 py-2 text-[11px] font-semibold text-[#4d7165]">{feedback}</div>}</form></section>
      <section className="overflow-hidden rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="border-b border-[#e5ebe5] bg-[#f8faf6] px-5 py-4"><h2 className="text-sm font-extrabold text-[#284139]">Administrator directory</h2><p className="mt-1 text-xs text-[#87958e]">{users.length} listed user{users.length === 1 ? '' : 's'} · one unrestricted role</p></div>{loading ? <div className="p-5"><LoadingRows count={3} /></div> : users.length === 0 ? <EmptyState icon={Users} title="No LDAP administrators" detail="Configure LDAP and add the first directory user." /> : <div className="divide-y divide-[#edf0eb]">{users.map((user) => <div key={user.id} className="flex items-center gap-3 px-5 py-4"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#dff2e9] text-[11px] font-extrabold text-[#28745b]">{initials(user.displayName || user.username)}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-extrabold text-[#365049]">{user.displayName || user.username}</div><div className="truncate font-mono text-[10px] text-[#87958e]">{user.username}{user.email ? ` · ${user.email}` : ''}</div></div><StatusPill value={user.isActive ? 'active' : 'disabled'} kind={user.isActive ? 'success' : 'neutral'} /><button type="button" onClick={() => void changeActive(user)} className="rounded-md px-2 py-1 text-[10px] font-bold text-[#4d7165] hover:bg-[#e7f2eb]">{user.isActive ? 'Disable' : 'Enable'}</button><button type="button" aria-label={`Remove ${user.username}`} onClick={() => void remove(user)} className="rounded-md p-2 text-[#9b7972] hover:bg-[#f9e3df] hover:text-[#a13a31]"><Trash2 size={14} /></button></div>)}</div>}</section>
    </div>
  </div>;
}

function SecurityPage() {
  const [ldap, setLdap] = useState<LdapSettings>({ enabled: false, url: '', bindDn: '', bindPasswordSet: false, baseDn: '', userFilter: '(&(objectClass=person)(sAMAccountName={{username}}))', usernameAttribute: 'sAMAccountName', displayNameAttribute: 'displayName', emailAttribute: 'mail', verifyTlsCertificate: true, caCertificateInstalled: false });
  const [ldapPassword, setLdapPassword] = useState('');
  const [ldapTest, setLdapTest] = useState({ username: '', password: '' });
  const [ssl, setSsl] = useState<SslSettings>({ certificateInstalled: false, privateKeyInstalled: false, chainInstalled: false, certificateFingerprint: null, certificateSubject: null, certificateExpiresAt: null, forceHttps: false, hstsEnabled: false });
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [chainPem, setChainPem] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([fetch('/api/settings/ldap', { credentials: 'include' }).then((response) => response.json()), fetch('/api/settings/ssl', { credentials: 'include' }).then((response) => response.json())]).then(([ldapBody, sslBody]) => { setLdap(ldapBody as LdapSettings); setSsl(sslBody as SslSettings); }).catch(() => setFeedback('Unable to load security settings.'));
  }, []);
  const updateLdap = <K extends keyof LdapSettings>(key: K, value: LdapSettings[K]) => setLdap((current) => ({ ...current, [key]: value }));
  const readPem = (setter: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void file.text().then(setter); };
  const saveLdap = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFeedback('');
    try {
      const response = await fetch('/api/settings/ldap', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: ldap.enabled, url: ldap.url, bindDn: ldap.bindDn, bindPassword: ldapPassword || undefined, baseDn: ldap.baseDn, userFilter: ldap.userFilter, usernameAttribute: ldap.usernameAttribute, displayNameAttribute: ldap.displayNameAttribute, emailAttribute: ldap.emailAttribute, verifyTlsCertificate: ldap.verifyTlsCertificate }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Unable to save LDAP settings.'); setLdap(body as LdapSettings); setLdapPassword(''); setFeedback('LDAP settings saved.');
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save LDAP settings.'); } finally { setBusy(false); }
  };
  const testLdap = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const response = await fetch('/api/settings/ldap/test', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ldapTest) }); const body = await response.json(); setFeedback(body.success ? body.message : `${body.stage}: ${body.message}`); } catch { setFeedback('LDAP diagnostic failed.'); } finally { setBusy(false); }
  };
  const saveSsl = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFeedback('');
    try {
      const response = await fetch('/api/settings/ssl', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certificatePem, privateKeyPem, chainPem, forceHttps: ssl.forceHttps, hstsEnabled: ssl.hstsEnabled }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Unable to save SSL settings.'); setSsl(body as SslSettings); setCertificatePem(''); setPrivateKeyPem(''); setChainPem(''); setFeedback('PKI certificate saved. HTTPS activation will be applied by the server runtime or reverse proxy.');
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save SSL settings.'); } finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-[1080px]"><PageHeader eyebrow="Trust and identity" title="Security" detail="Connect administrator access to LDAP and activate HTTPS with your organization’s PKI certificate." />{feedback && <div role="status" className="mb-5 rounded-lg border border-[#b9d8c5] bg-[#e6f4eb] px-4 py-3 text-xs font-semibold text-[#317357]">{feedback}</div>}<div className="grid gap-6 xl:grid-cols-2">
    <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><Users size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">LDAP directory</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">The bind password is encrypted before it is stored in PostgreSQL.</p></div></div><form onSubmit={saveLdap} className="space-y-3"><SettingToggle label="Enable LDAP administrators" detail="Added users authenticate against this directory." value={ldap.enabled} onChange={(value) => updateLdap('enabled', value)} testId="toggle-ldap-enabled" /><label className="block"><span className="field-label">LDAP URL</span><input required value={ldap.url} onChange={(event) => updateLdap('url', event.target.value)} placeholder="ldaps://directory.example.com:636" className="field-input font-mono" /></label><label className="block"><span className="field-label">Service bind DN</span><input value={ldap.bindDn} onChange={(event) => updateLdap('bindDn', event.target.value)} placeholder="CN=svc-nemesys,OU=Service Accounts,DC=example,DC=local" className="field-input font-mono" /></label><label className="block"><span className="field-label">Service bind password {ldap.bindPasswordSet && <span className="font-normal normal-case text-[#4d9475]">(saved)</span>}</span><input type="password" value={ldapPassword} onChange={(event) => setLdapPassword(event.target.value)} placeholder={ldap.bindPasswordSet ? 'Leave blank to keep saved password' : 'Required for directory search'} className="field-input" /></label><label className="block"><span className="field-label">Base DN</span><input required value={ldap.baseDn} onChange={(event) => updateLdap('baseDn', event.target.value)} placeholder="DC=example,DC=local" className="field-input font-mono" /></label><label className="block"><span className="field-label">User filter</span><input required value={ldap.userFilter} onChange={(event) => updateLdap('userFilter', event.target.value)} className="field-input font-mono" /></label><div className="grid gap-3 sm:grid-cols-3"><label><span className="field-label">Username attr.</span><input value={ldap.usernameAttribute} onChange={(event) => updateLdap('usernameAttribute', event.target.value)} className="field-input font-mono" /></label><label><span className="field-label">Display attr.</span><input value={ldap.displayNameAttribute} onChange={(event) => updateLdap('displayNameAttribute', event.target.value)} className="field-input font-mono" /></label><label><span className="field-label">Email attr.</span><input value={ldap.emailAttribute} onChange={(event) => updateLdap('emailAttribute', event.target.value)} className="field-input font-mono" /></label></div><SettingToggle label="Verify TLS certificate" detail="Recommended for LDAPS and organization CAs." value={ldap.verifyTlsCertificate} onChange={(value) => updateLdap('verifyTlsCertificate', value)} testId="toggle-ldap-tls" /><Button type="submit" disabled={busy}><Save size={14} />Save LDAP settings</Button></form><form onSubmit={testLdap} className="mt-5 space-y-3 border-t border-[#e7ece7] pt-4"><div className="text-xs font-extrabold text-[#38534a]">Connection diagnostic</div><div className="grid gap-3 sm:grid-cols-2"><input required placeholder="Test username" value={ldapTest.username} onChange={(event) => setLdapTest((current) => ({ ...current, username: event.target.value }))} className="field-input" /><input required type="password" placeholder="Test password" value={ldapTest.password} onChange={(event) => setLdapTest((current) => ({ ...current, password: event.target.value }))} className="field-input" /></div><Button type="submit" variant="secondary" disabled={busy}>Test LDAP connection</Button></form></section>
    <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><ShieldCheck size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Organization PKI / HTTPS</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">PEM material is validated, matched, and encrypted at rest for Kubernetes-safe persistence.</p></div></div><form onSubmit={saveSsl} className="space-y-3"><label className="block"><span className="field-label">Certificate PEM</span><textarea required={ !ssl.certificateInstalled } value={certificatePem} onChange={(event) => setCertificatePem(event.target.value)} placeholder={ssl.certificateInstalled ? 'Leave blank to keep the installed certificate' : '-----BEGIN CERTIFICATE-----'} className="field-input min-h-28 font-mono text-[10px]" /><input type="file" accept=".pem,.crt,.cer" onChange={readPem(setCertificatePem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><label className="block"><span className="field-label">Private key PEM</span><textarea required={!ssl.privateKeyInstalled} value={privateKeyPem} onChange={(event) => setPrivateKeyPem(event.target.value)} placeholder={ssl.privateKeyInstalled ? 'Leave blank to keep the installed private key' : '-----BEGIN PRIVATE KEY-----'} className="field-input min-h-28 font-mono text-[10px]" /><input type="file" accept=".pem,.key" onChange={readPem(setPrivateKeyPem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><label className="block"><span className="field-label">Certificate chain PEM <span className="font-normal normal-case">(optional)</span></span><textarea value={chainPem} onChange={(event) => setChainPem(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="field-input min-h-20 font-mono text-[10px]" /><input type="file" accept=".pem,.crt,.cer" onChange={readPem(setChainPem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><div className="rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3 text-xs text-[#536b68]"><div className="flex items-center justify-between"><span>Certificate</span><StatusPill value={ssl.certificateInstalled ? 'installed' : 'missing'} kind={ssl.certificateInstalled ? 'success' : 'warning'} /></div>{ssl.certificateSubject && <div className="mt-2 truncate font-mono text-[10px]">{ssl.certificateSubject}</div>}{ssl.certificateExpiresAt && <div className="mt-1 font-mono text-[10px]">Expires {formatTime(ssl.certificateExpiresAt)}</div>}</div><SettingToggle label="Activate HTTPS" detail="Serve the API over the uploaded certificate and redirect HTTP requests." value={ssl.forceHttps} onChange={(value) => setSsl((current) => ({ ...current, forceHttps: value }))} testId="toggle-force-https" /><SettingToggle label="Enable HSTS" detail="Only enable after HTTPS is confirmed reachable." value={ssl.hstsEnabled} onChange={(value) => setSsl((current) => ({ ...current, hstsEnabled: value }))} testId="toggle-hsts" /><Button type="submit" disabled={busy}><Upload size={14} />Save certificate settings</Button></form></section>
  </div></div>;
}

function ApiKeyPage() {
  const settings = useGetServerSettings();
  const current = useGetClientApiKey();
  const rotate = useRotateClientApiKey();
  const [customKey, setCustomKey] = useState('');
  const [result, setResult] = useState<ApiKeyRotation | null>(null);
  const [feedback, setFeedback] = useState('');
  const configuredKey = current.data as ClientApiKeyStatus | undefined;
  const saveCustom = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback('');
    try {
      const response = await fetch('/api/settings/api-key', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: customKey }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Unable to save API key.');
      setResult(body as ApiKeyRotation);
      setCustomKey('');
      setFeedback('The saved key is shown below and will remain available to authenticated administrators.');
      queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/api-key'] });
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save API key.'); }
  };
  const generate = () => rotate.mutate(undefined, { onSuccess: (body) => { setResult(body); setFeedback('A new key was generated intentionally. Copy it now for client reconfiguration.'); queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() }); queryClient.invalidateQueries({ queryKey: ['/api/settings/api-key'] }); } });
  return <div className="mx-auto max-w-[900px]"><PageHeader eyebrow="Client transport" title="Client API key" detail="Manage the shared key used by Windows services. Existing clients continue working until you intentionally replace the key." /><div className="grid gap-6 md:grid-cols-2"><section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><LockKeyhole size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Current key</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">{settings.data?.apiKeyConfigured ? `Configured · last changed ${formatTime(settings.data.apiKeyLastRotatedAt)}` : 'No shared key has been configured.'}</p></div></div>{configuredKey?.apiKey ? <div className="rounded-lg border border-[#b9d8c5] bg-[#f1faf3] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#317357]">Configured key</div><code data-testid="text-configured-api-key" className="mt-2 block break-all font-mono text-xs text-[#284139]">{configuredKey.apiKey}</code><Button type="button" variant="secondary" className="mt-3" onClick={() => { void navigator.clipboard?.writeText(configuredKey.apiKey ?? ''); }}>Copy configured key</Button></div> : configuredKey?.configured ? <div className="rounded-lg border border-[#e4c6b6] bg-[#fff5ee] p-3 text-xs leading-5 text-[#8f5d4e]">This key was saved before encrypted key recovery was enabled. It cannot be read back from its hash. Use “Save chosen key” to preserve the key you already have, or generate a replacement.</div> : null}<Button type="button" className="mt-4" onClick={generate} disabled={rotate.isPending}><RotateCcw size={14} />{rotate.isPending ? 'Generating…' : 'Generate new key'}</Button><p className="mt-3 text-[11px] leading-5 text-[#71817c]">Generating or saving a key replaces the current key immediately, so older clients must be reconfigured with the returned value.</p></section><section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><h2 className="text-sm font-extrabold text-[#284139]">Save an existing/custom key</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">Use this to preserve a chosen key during migration. It will be encrypted for future display while the server continues authenticating with its hash.</p><form onSubmit={saveCustom} className="mt-4 space-y-3"><input required minLength={16} maxLength={256} type="password" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="At least 16 characters" className="field-input font-mono" /><Button type="submit" variant="secondary">Save chosen key</Button></form></section></div>{result && <section className="mt-6 rounded-xl border border-[#e4c6b6] bg-[#fff5ee] p-5"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#a45d3e]">Full key — copy now</div><code data-testid="text-full-api-key" className="mt-2 block break-all rounded-md bg-[#fffdf8] p-3 font-mono text-xs text-[#586c6d]">{result.apiKey}</code><Button type="button" variant="secondary" className="mt-3" onClick={() => { void navigator.clipboard?.writeText(result.apiKey); }}>Copy key</Button></section>}{feedback && <div role="status" className="mt-4 rounded-lg bg-[#e6f4eb] px-3 py-2 text-xs font-semibold text-[#317357]">{feedback}</div>}</div>;
}

function SettingsPage() {
  const query = useGetServerSettings();
  const update = useUpdateServerSettings();
  const rotate = useRotateClientApiKey();
  const [form, setForm] = useState<ServerSettings>({ syncIntervalSeconds: 300, syncPort: 8443, adminHttpsEnabled: true, apiKeyConfigured: false, apiKeyLastRotatedAt: null, updateMode: false, normalCloseTimeoutSeconds: 30, updateModeCloseTimeoutSeconds: 8 });
  const [updateMode, setUpdateMode] = useState(false);
  const [serverHostname, setServerHostname] = useState(window.location.hostname || 'api.nemesys.local');
  const [rotation, setRotation] = useState<ApiKeyRotation | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (query.data && !initialized) { setForm(query.data); setUpdateMode(query.data.updateMode); setInitialized(true); } }, [query.data, initialized]);
  const set = <K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = (event: FormEvent) => { event.preventDefault(); update.mutate({ data: { syncIntervalSeconds: Number(form.syncIntervalSeconds), syncPort: Number(form.syncPort), adminHttpsEnabled: form.adminHttpsEnabled, updateMode, normalCloseTimeoutSeconds: Number(form.normalCloseTimeoutSeconds), updateModeCloseTimeoutSeconds: Number(form.updateModeCloseTimeoutSeconds) } }, { onSuccess: (saved) => { setForm(saved); setUpdateMode(saved.updateMode); setFeedback('Settings saved and will apply to the next client sync.'); queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() }); } }); };
  const rotateKey = () => { rotate.mutate(undefined, { onSuccess: (result) => { setRotation(result); setFeedback('New API key generated. Use the one-time command below to install or reconfigure clients.'); queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() }); } }); };
  const serverEndpoint = /^https?:\/\//i.test(serverHostname) ? serverHostname : `https://${serverHostname}`;
  const installCommand = rotation ? `NemesysClientSetup.exe /quiet /server "${serverEndpoint}" /port ${form.syncPort} /apiKey "${rotation.apiKey}"` : '';
  return <div className="mx-auto max-w-[1080px]">
      <PageHeader eyebrow="Control plane configuration" title="Settings" detail="Tune the shared API-key transport, server endpoint, and synchronization cadence for enrolled Windows clients." action={<AdminPasswordPanel />} />
    {query.isError ? <ErrorState onRetry={() => query.refetch()} /> : query.isLoading && !initialized ? <LoadingRows count={4} /> : <form onSubmit={save} className="grid gap-6 lg:grid-cols-[1.25fr_.75fr]"><div className="space-y-6">
      <section data-testid="panel-api-key-transport" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><LockKeyhole size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Shared API key transport</h2><p className="mt-1 text-xs text-[#87958e]">Clients identify by hostname and use a shared key. The server stores only a hash.</p></div></div><div className="flex items-center justify-between rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3"><div><div className="text-xs font-bold text-[#38534a]">Key status</div><div data-testid="status-shared-api-key" className="mt-1 text-[10px] text-[#28745b]">{rotation ? 'New key ready for silent install' : form.apiKeyConfigured ? `Configured · rotated ${formatTime(form.apiKeyLastRotatedAt)}` : 'Not configured'}</div></div><Button type="button" variant="secondary" data-testid="button-rotate-api-key" onClick={rotateKey} disabled={rotate.isPending}><RotateCcw size={13} />{rotate.isPending ? 'Generating…' : 'Rotate key'}</Button></div>{rotation && <div className="mt-4 rounded-lg border border-[#e4c6b6] bg-[#fff5ee] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#a45d3e]">One-time installation command</div><code data-testid="text-silent-install-command" className="mt-2 block break-all rounded-md bg-[#fffdf8] p-2 font-mono text-[11px] leading-5 text-[#586c6d]">{installCommand}</code><Button type="button" variant="secondary" className="mt-3" data-testid="button-copy-install-command" onClick={() => { void navigator.clipboard?.writeText(installCommand); }}>Copy command</Button><div className="mt-2 text-[10px] leading-4 text-[#8f766b]">The API key is returned once. The client installer must encrypt it on the machine; the server hostname remains clear text in the client configuration.</div></div>}</section>
      <section data-testid="panel-server-endpoint" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#fff0d5] text-[#94661a]"><Globe2 size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Server hostname and endpoint</h2><p className="mt-1 text-xs text-[#87958e]">The hostname is safe to keep in clear text so the Windows service can locate this Kubernetes-hosted control plane.</p></div></div><label className="block max-w-sm"><span className="field-label">Server hostname</span><input data-testid="input-server-hostname" value={serverHostname} onChange={(e) => setServerHostname(e.target.value)} className="field-input font-mono" /></label><label className="mt-4 block max-w-sm"><span className="field-label">Sync port</span><input type="number" min="1" max="65535" required data-testid="input-sync-port" value={form.syncPort} onChange={(e) => set('syncPort', Number(e.target.value))} className="field-input font-mono" /></label></section>
       <section data-testid="panel-update-timeouts" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><Clock3 size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Client close-timeout defaults</h2><p className="mt-1 text-xs text-[#87958e]">Update Mode is selected on each software policy. These defaults cover policies that do not opt into the application-specific short timeout.</p></div></div><div className="grid gap-3 sm:grid-cols-2"><label><span className="field-label">Normal timeout</span><input type="number" min="5" max="3600" required data-testid="input-normal-timeout" value={form.normalCloseTimeoutSeconds} onChange={(e) => set('normalCloseTimeoutSeconds', Number(e.target.value))} className="field-input font-mono" /></label><label><span className="field-label">Legacy short default</span><input type="number" min="1" max="300" required data-testid="input-short-timeout" value={form.updateModeCloseTimeoutSeconds} onChange={(e) => set('updateModeCloseTimeoutSeconds', Number(e.target.value))} className="field-input font-mono" /></label></div></section>
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><Activity size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Synchronization cadence</h2><p className="mt-1 text-xs text-[#87958e]">How often clients ask for their effective policy configuration.</p></div></div><label className="block max-w-sm"><span className="field-label">Sync interval (seconds)</span><input type="number" min="10" max="86400" required data-testid="input-sync-interval" value={form.syncIntervalSeconds} onChange={(e) => set('syncIntervalSeconds', Number(e.target.value))} className="field-input font-mono" /></label></section>
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3eaf3] text-[#405e80]"><Settings2 size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Administration channel</h2><p className="mt-1 text-xs text-[#87958e]">Protect the control center session and keep client transport separate.</p></div></div><SettingToggle label="Admin HTTPS" detail="Protect the control center session with HTTPS." value={form.adminHttpsEnabled} onChange={(value) => set('adminHttpsEnabled', value)} testId="toggle-admin-https" /><div className="mt-3 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3 text-xs"><div className="font-bold text-[#38534a]">Shared API-key client access</div><div className="mt-1 text-[10px] text-[#87958e]">The server stores a SHA-256 hash; clients authenticate with the encrypted local key and hostname identity.</div></div></section></div><div className="space-y-4"><div className="sticky top-[94px] rounded-xl border border-[#dbe3dd] bg-[#203c4a] p-5 text-[#edf5ee] shadow-[0_7px_25px_rgba(29,55,63,.1)]"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8ec5ad]"><ShieldCheck size={14} /> Connection posture</div><div className="mt-4 space-y-3"><div className="flex items-center justify-between border-b border-[#365563] pb-3 text-xs"><span className="text-[#aec3bd]">Server endpoint</span><span data-testid="text-server-endpoint" className="font-mono font-bold text-[#b9e7ca]">{serverHostname}:{form.syncPort}</span></div><div className="flex items-center justify-between border-b border-[#365563] pb-3 text-xs"><span className="text-[#aec3bd]">Client identity</span><span className="font-mono font-bold text-[#b9e7ca]">HOSTNAME</span></div><div className="flex items-center justify-between text-xs"><span className="text-[#aec3bd]">Client interval</span><span className="font-mono font-bold text-[#b9e7ca]">{form.syncIntervalSeconds}s</span></div></div><Button type="submit" disabled={update.isPending} className="mt-6 w-full"><Save size={14} />{update.isPending ? 'Applying changes…' : 'Save settings'}</Button>{feedback && <div className="mt-3 flex gap-2 rounded-lg bg-[#2b584b] px-3 py-2 text-[11px] leading-4 text-[#bde8cb]"><CheckCircle2 size={14} className="mt-0.5 shrink-0" />{feedback}</div>}</div><div className="rounded-xl border border-[#dbe3dd] bg-[#fbfcf8] p-4"><div className="flex gap-2 text-xs font-bold text-[#486159]"><CircleHelp size={15} className="text-[#5d947b]" /> Configuration status</div><p className="mt-2 text-[11px] leading-5 text-[#84928c]">Hostname is supplied by the administrator, key rotation returns the value once, and Update Mode settings are persisted for the Windows service.</p></div></div></form>}
  </div>;
}

function SettingToggle({ label, detail, value, onChange, testId }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void; testId: string }) {
  return <div className="flex items-center justify-between gap-4 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3"><div><div className="text-xs font-bold text-[#38534a]">{label}</div><div className="mt-1 text-[10px] text-[#87958e]">{detail}</div></div><button type="button" role="switch" aria-checked={value} data-testid={testId} onClick={() => onChange(!value)} className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', value ? 'bg-[#2b8a63]' : 'bg-[#b7c3bc]')}><span className={cx('absolute top-1 h-4 w-4 rounded-full bg-[#fffdf8] shadow-sm transition-transform', value ? 'translate-x-6' : 'translate-x-1')} /></button></div>;
}

function Router() {
  return <ErrorBoundary resetKey={window.location.pathname}><Layout><Switch><Route path="/" component={OverviewPage} /><Route path="/clients" component={ClientsPage} /><Route path="/software" component={SoftwarePage} /><Route path="/audit" component={AuditPage} /><Route path="/administrators" component={AdministratorsPage} /><Route path="/security" component={SecurityPage} /><Route path="/api-key" component={ApiKeyPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></Layout></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AuthGate><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></AuthGate></QueryClientProvider>;
}

export default App;