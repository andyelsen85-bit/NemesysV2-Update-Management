import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Eye,
  FileCode2,
  Filter,
  KeyRound,
  Laptop,
  LockKeyhole,
  MonitorCog,
  Pencil,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Wifi,
  X,
} from "lucide-react";

type HostStatus = "healthy" | "attention" | "offline";

type Host = {
  hostname: string;
  group: string;
  ip: string;
  status: HostStatus;
  lastSync: string;
  syncDetail: string;
  agent: string;
  pending: number;
};

type ExeCheck = {
  file: string;
  operator: string;
  version: string;
};

type IniCheck = {
  file: string;
  section: string;
  key: string;
  value: string;
};

type ApplicationPolicy = {
  id: string;
  name: string;
  publisher: string;
  icon: string;
  scope: string;
  status: "Protected" | "Review";
  updated: string;
  exes: ExeCheck[];
  ini: IniCheck[];
};

const hosts: Host[] = [
  {
    hostname: "BER-OPS-014",
    group: "Berlin / Operations",
    ip: "10.42.18.14",
    status: "healthy",
    lastSync: "2 min ago",
    syncDetail: "Today at 09:42:18 CET",
    agent: "2.8.4",
    pending: 0,
  },
  {
    hostname: "PAR-MED-027",
    group: "Paris / Clinical",
    ip: "10.42.21.27",
    status: "attention",
    lastSync: "18 min ago",
    syncDetail: "Today at 09:26:03 CET",
    agent: "2.8.3",
    pending: 3,
  },
  {
    hostname: "LON-FIN-008",
    group: "London / Finance",
    ip: "10.42.12.8",
    status: "healthy",
    lastSync: "31 min ago",
    syncDetail: "Today at 09:13:44 GMT",
    agent: "2.8.4",
    pending: 1,
  },
  {
    hostname: "AMS-WKS-113",
    group: "Amsterdam / Workstations",
    ip: "10.42.31.113",
    status: "offline",
    lastSync: "2 hr ago",
    syncDetail: "Today at 07:51:10 CET",
    agent: "2.8.1",
    pending: 7,
  },
  {
    hostname: "MAD-RND-041",
    group: "Madrid / Research",
    ip: "10.42.26.41",
    status: "healthy",
    lastSync: "4 min ago",
    syncDetail: "Today at 09:40:05 CET",
    agent: "2.8.4",
    pending: 0,
  },
];

const initialPolicies: ApplicationPolicy[] = [
  {
    id: "poste",
    name: "Poste",
    publisher: "Nemesys clinical workstation",
    icon: "P",
    scope: "Clinical workstations",
    status: "Protected",
    updated: "Updated 3 days ago",
    exes: [
      { file: "Poste.exe", operator: "≥", version: "4.5.4.0" },
      { file: "PosteMed.exe", operator: "≥", version: "4.1.8.0" },
    ],
    ini: [
      { file: "Poste.ini", section: "Poste", key: "Version", value: "454" },
      { file: "Poste.ini", section: "Poste", key: "VersMedSyst", value: "418" },
    ],
  },
  {
    id: "claimsdesk",
    name: "ClaimsDesk",
    publisher: "Northstar Systems",
    icon: "C",
    scope: "Finance workstations",
    status: "Protected",
    updated: "Updated 8 days ago",
    exes: [{ file: "ClaimsDesk.exe", operator: "≥", version: "7.12.2.0" }],
    ini: [
      { file: "claims.ini", section: "Release", key: "Channel", value: "stable" },
    ],
  },
  {
    id: "dispatch",
    name: "Dispatch Console",
    publisher: "Vektor Logistics",
    icon: "D",
    scope: "Operations endpoints",
    status: "Review",
    updated: "Updated 19 days ago",
    exes: [
      { file: "Dispatch.exe", operator: "=", version: "3.9.14.0" },
      { file: "DispatchBridge.exe", operator: "≥", version: "3.9.10.0" },
    ],
    ini: [],
  },
];

const statusMeta: Record<
  HostStatus,
  { label: string; color: string; background: string; icon: typeof CircleCheck }
> = {
  healthy: {
    label: "In sync",
    color: "#23725d",
    background: "#e6f4ee",
    icon: CircleCheck,
  },
  attention: {
    label: "Attention",
    color: "#b35c37",
    background: "#fff0e6",
    icon: AlertTriangle,
  },
  offline: {
    label: "Offline",
    color: "#777f86",
    background: "#eef0ef",
    icon: Clock3,
  },
};

function StatusPill({ status }: { status: HostStatus }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em]"
      style={{ color: meta.color, background: meta.background }}
    >
      <Icon size={13} strokeWidth={2.2} />
      {meta.label}
    </span>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone = "teal",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Server;
  tone?: "teal" | "orange" | "slate" | "blue";
}) {
  const tones = {
    teal: { surface: "#e3f1ed", ink: "#226b5d", accent: "#65aa97" },
    orange: { surface: "#fff0e7", ink: "#aa5637", accent: "#e8986e" },
    slate: { surface: "#e9eeef", ink: "#49616a", accent: "#90a7aa" },
    blue: { surface: "#e8f0f4", ink: "#3e667a", accent: "#81aabd" },
  };
  const selected = tones[tone];
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-xl"
        style={{ color: selected.ink, background: selected.surface }}
      >
        <Icon size={17} strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[#7c898c]">
          {label}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="font-['Space_Grotesk'] text-[23px] font-semibold tracking-[-0.04em] text-[#1c3036]">
            {value}
          </span>
          <span className="truncate text-[11px] text-[#879297]">{detail}</span>
        </div>
        <div className="mt-2 h-1 w-28 overflow-hidden rounded-full bg-[#e9eeee]">
          <div
            className="h-full rounded-full"
            style={{ width: tone === "orange" ? "56%" : "78%", background: selected.accent }}
          />
        </div>
      </div>
    </div>
  );
}

function PolicyRow({
  policy,
  expanded,
  onToggle,
  onEdit,
}: {
  policy: ApplicationPolicy;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="border-b border-[#e6ece9] last:border-b-0">
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${policy.name}`}
          onClick={onToggle}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[#809093] transition-colors hover:bg-[#edf3f0] hover:text-[#264c4c]"
        >
          {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </button>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#d3e3de] bg-[#edf5f1] font-['Space_Grotesk'] text-sm font-bold text-[#26705f]">
          {policy.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-['Space_Grotesk'] text-[15px] font-semibold text-[#20373b]">
              {policy.name}
            </span>
            <span className="rounded-full bg-[#edf5f1] px-2 py-0.5 text-[10px] font-semibold text-[#337563]">
              {policy.status}
            </span>
          </div>
          <div className="mt-1 text-xs text-[#849195]">
            {policy.publisher} <span className="px-1 text-[#c0c9c7]">·</span>{" "}
            {policy.scope}
          </div>
        </div>
        <div className="hidden items-center gap-4 md:flex">
          <div className="text-right">
            <div className="font-['Space_Grotesk'] text-sm font-semibold text-[#395056]">
              {policy.exes.length + policy.ini.length}
            </div>
            <div className="text-[10px] uppercase tracking-[0.1em] text-[#9aa4a6]">
              checks
            </div>
          </div>
          <span className="w-[112px] text-right text-[11px] text-[#8d999b]">{policy.updated}</span>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#dce6e2] bg-[#fbfcfa] px-2.5 py-2 text-xs font-semibold text-[#47716c] transition-all hover:border-[#a9c8be] hover:bg-[#edf5f1]"
        >
          <Pencil size={13} />
          <span className="hidden sm:inline">Inspect / edit</span>
        </button>
      </div>
      {expanded && (
        <div className="grid gap-4 bg-[#f6f9f7] px-5 pb-5 pl-[60px] pt-1 md:grid-cols-2">
          <div className="rounded-xl border border-[#e2ebe7] bg-[#fcfdfc] p-3.5">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#69827e]">
              <FileCode2 size={14} />
              Executable version checks
            </div>
            <div className="space-y-2">
              {policy.exes.map((check) => (
                <div
                  key={check.file}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#e8efec] bg-[#f8fbf9] px-3 py-2"
                >
                  <span className="font-mono text-[11px] text-[#496268]">{check.file}</span>
                  <span className="font-mono text-[11px] font-semibold text-[#236d5d]">
                    {check.operator} {check.version}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-[#e2ebe7] bg-[#fcfdfc] p-3.5">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#69827e]">
              <Braces size={14} />
              INI section / key / value
            </div>
            <div className="space-y-2">
              {policy.ini.length ? (
                policy.ini.map((check) => (
                  <div
                    key={`${check.file}-${check.key}`}
                    className="rounded-lg border border-[#e8efec] bg-[#f8fbf9] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-[#789096]">{check.file}</span>
                      <span className="rounded bg-[#e6f1ed] px-1.5 py-0.5 font-mono text-[10px] text-[#317362]">
                        [{check.section}]
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[11px]">
                      <span className="text-[#536d73]">{check.key}</span>
                      <span className="font-semibold text-[#b05e3e]">{check.value}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-[#d8e4df] px-3 py-3 text-xs text-[#94a09f]">
                  No INI checks in this policy.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModalShell({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#173033]/35 p-4 backdrop-blur-[3px]">
      <div className="w-full max-w-[470px] overflow-hidden rounded-2xl border border-[#d7e4df] bg-[#fbfdfb] shadow-[0_24px_70px_rgba(27,58,57,0.22)]">
        <div className="flex items-start justify-between border-b border-[#e4ece9] px-6 py-5">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#6a8f86]">
              {eyebrow}
            </div>
            <h2 className="mt-1 font-['Space_Grotesk'] text-xl font-semibold tracking-[-0.035em] text-[#21373a]">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-[#849293] hover:bg-[#eef3f0] hover:text-[#29494a]"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function UpdatedControlCenter() {
  const [updateMode, setUpdateMode] = useState(false);
  const [expandedPolicies, setExpandedPolicies] = useState<string[]>(["poste"]);
  const [policies, setPolicies] = useState<ApplicationPolicy[]>(initialPolicies);
  const [search, setSearch] = useState("");
  const [showOnlyAttention, setShowOnlyAttention] = useState(false);
  const [activeSection, setActiveSection] = useState("Overview");
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<ApplicationPolicy | null>(null);
  const [editName, setEditName] = useState("");
  const [editScope, setEditScope] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState("09:44 CET");

  const filteredHosts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return hosts.filter((host) => {
      const matchesSearch =
        !query ||
        host.hostname.toLowerCase().includes(query) ||
        host.group.toLowerCase().includes(query);
      const matchesAttention = !showOnlyAttention || host.status !== "healthy";
      return matchesSearch && matchesAttention;
    });
  }, [search, showOnlyAttention]);

  const togglePolicy = (id: string) => {
    setExpandedPolicies((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const openPolicyEditor = (policy: ApplicationPolicy) => {
    setEditingPolicy(policy);
    setEditName(policy.name);
    setEditScope(policy.scope);
  };

  const savePolicy = () => {
    if (!editingPolicy || !editName.trim()) return;
    setPolicies((current) =>
      current.map((policy) =>
        policy.id === editingPolicy.id
          ? { ...policy, name: editName.trim(), scope: editScope.trim() || policy.scope, updated: "Updated just now" }
          : policy,
      ),
    );
    setEditingPolicy(null);
  };

  const refreshEstate = () => {
    setRefreshing(true);
    window.setTimeout(() => {
      setLastChecked("just now");
      setRefreshing(false);
    }, 650);
  };

  const confirmRotation = () => {
    setRotated(true);
    setRotateOpen(false);
  };

  return (
    <div className="min-h-[100dvh] bg-[#f3f6f3] font-['DM_Sans'] text-[#263c40]">
      <style>{`
        @keyframes cc-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes cc-pulse { 0%, 100% { opacity: .65; } 50% { opacity: 1; } }
        .cc-rise { animation: cc-rise .55s cubic-bezier(.22,.8,.27,1) both; }
        .cc-delay-1 { animation-delay: 70ms; }
        .cc-delay-2 { animation-delay: 140ms; }
        .cc-delay-3 { animation-delay: 210ms; }
        .cc-delay-4 { animation-delay: 280ms; }
        .cc-scrollbar::-webkit-scrollbar { width: 7px; height: 7px; }
        .cc-scrollbar::-webkit-scrollbar-thumb { background: #c8d7d1; border-radius: 12px; }
        .cc-scrollbar::-webkit-scrollbar-track { background: transparent; }
      `}</style>
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[238px] shrink-0 flex-col border-r border-[#d7e2de] bg-[#e8f0ec] px-4 py-5 lg:flex">
          <div className="flex items-center gap-3 px-2">
            <div className="flex size-9 items-center justify-center rounded-[11px] bg-[#1f4f51] text-[#d6eee6] shadow-[0_7px_16px_rgba(36,93,88,.18)]">
              <MonitorCog size={20} strokeWidth={1.7} />
            </div>
            <div>
              <div className="font-['Space_Grotesk'] text-[15px] font-semibold tracking-[-0.03em] text-[#1f3a3c]">
                Nemesys<span className="text-[#c15f3d]">V2</span>
              </div>
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#77908d]">
                Control center
              </div>
            </div>
          </div>

          <div className="mt-10 px-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#91a09d]">
            Workspace
          </div>
          <nav className="mt-2 space-y-1">
            {[
              { label: "Overview", icon: Activity },
              { label: "Computers", icon: Laptop, count: "48" },
              { label: "Applications", icon: FileCode2, count: "12" },
              { label: "Update window", icon: CalendarClock },
            ].map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.label;
              return (
                <button
                  type="button"
                  key={item.label}
                  onClick={() => setActiveSection(item.label)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
                    isActive
                      ? "bg-[#d0e6de] text-[#255b57]"
                      : "text-[#68817e] hover:bg-[#dceae5] hover:text-[#2b5553]"
                  }`}
                >
                  <Icon size={17} strokeWidth={isActive ? 2.1 : 1.7} />
                  <span className="flex-1">{item.label}</span>
                  {item.count && (
                    <span className={`font-mono text-[10px] ${isActive ? "text-[#3e8376]" : "text-[#94a4a1]"}`}>
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="mt-7 px-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#91a09d]">
            Governance
          </div>
          <nav className="mt-2 space-y-1">
            <button
              type="button"
              onClick={() => setActiveSection("Security")}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
                activeSection === "Security"
                  ? "bg-[#d0e6de] text-[#255b57]"
                  : "text-[#68817e] hover:bg-[#dceae5] hover:text-[#2b5553]"
              }`}
            >
              <LockKeyhole size={17} strokeWidth={1.8} />
              <span>Security</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection("Audit log")}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition-colors ${
                activeSection === "Audit log"
                  ? "bg-[#d0e6de] text-[#255b57]"
                  : "text-[#68817e] hover:bg-[#dceae5] hover:text-[#2b5553]"
              }`}
            >
              <TerminalSquare size={17} strokeWidth={1.8} />
              <span>Audit log</span>
            </button>
          </nav>

          <div className="mt-auto rounded-2xl border border-[#d2e0da] bg-[#f2f7f4] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#65827d]">
              <Wifi size={14} />
              Server connection
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="size-2 rounded-full bg-[#4fa187]" />
              <span className="text-xs font-semibold text-[#3d6561]">Connected</span>
              <span className="ml-auto font-mono text-[10px] text-[#8da09d]">EU-1</span>
            </div>
            <div className="mt-2 font-mono text-[10px] text-[#94a29f]">api.nemesys.local:8443</div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="flex min-h-[72px] items-center justify-between border-b border-[#dfe7e3] bg-[#f8faf8]/90 px-5 backdrop-blur md:px-8">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-[#dcebe5] text-[#3d7167] lg:hidden">
                <MonitorCog size={17} />
              </div>
              <div>
                <div className="font-['Space_Grotesk'] text-[15px] font-semibold tracking-[-0.025em] text-[#20383b]">
                  {activeSection}
                </div>
                <div className="mt-0.5 text-[11px] text-[#879492]">Fleet operations / Europe</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2 rounded-lg border border-[#dde7e3] bg-[#f2f6f3] px-3 py-2 text-[11px] text-[#78908d] sm:flex">
                <ShieldCheck size={14} className="text-[#4b8f7d]" />
                <span>Administrator</span>
              </div>
              <div className="flex size-8 items-center justify-center rounded-full bg-[#d9e6e2] font-['Space_Grotesk'] text-xs font-bold text-[#3e7069]">
                AK
              </div>
            </div>
          </header>

          <div className="cc-scrollbar max-h-[calc(100dvh-72px)] overflow-y-auto px-5 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-[1440px]">
              <div className="cc-rise flex flex-col justify-between gap-5 md:flex-row md:items-end">
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#78918d]">
                    <span className="size-1.5 rounded-full bg-[#4e9a85]" />
                    Operations snapshot
                  </div>
                  <h1 className="mt-2 font-['Space_Grotesk'] text-[30px] font-semibold tracking-[-0.055em] text-[#1d3539] md:text-[36px]">
                    Good morning, Alex.
                  </h1>
                  <p className="mt-1.5 max-w-[590px] text-[13px] leading-6 text-[#819094]">
                    Your Windows estate is reporting normally. Update policies are ready for a controlled intervention.
                  </p>
                </div>
                <div className="flex items-center gap-2 self-start md:self-auto">
                  <span className="hidden text-[11px] text-[#94a09f] sm:inline">Last checked {lastChecked}</span>
                  <button
                    type="button"
                    onClick={refreshEstate}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#d4e1dc] bg-[#f9fbf9] px-3 py-2 text-xs font-semibold text-[#52736f] transition-colors hover:border-[#a9c8be] hover:bg-[#edf5f1]"
                  >
                    <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
                    Refresh estate
                  </button>
                </div>
              </div>

              <section
                className={`cc-rise cc-delay-1 mt-7 overflow-hidden rounded-2xl border transition-colors ${
                  updateMode
                    ? "border-[#b4d5c8] bg-[#e5f3ec]"
                    : "border-[#ead9cc] bg-[#fbf0e7]"
                }`}
              >
                <div className="flex flex-col gap-5 px-5 py-5 md:flex-row md:items-center md:justify-between md:px-6">
                  <div className="flex items-start gap-4">
                    <div
                      className={`mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl ${
                        updateMode ? "bg-[#c7e5d8] text-[#297660]" : "bg-[#f6dccc] text-[#b5613c]"
                      }`}
                    >
                      {updateMode ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-['Space_Grotesk'] text-[18px] font-semibold tracking-[-0.035em] text-[#263d3e]">
                           Application Update Mode
                        </h2>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${
                            updateMode ? "bg-[#277b64] text-[#effaf5]" : "bg-[#f6dfd1] text-[#a75d3d]"
                          }`}
                        >
                          {updateMode ? "Active" : "Standby"}
                        </span>
                      </div>
                      <p className="mt-1.5 max-w-[650px] text-[12px] leading-5 text-[#718481]">
                        {updateMode
                           ? "Each application policy uses its own short close-on-start timeout during its controlled update window."
                           : "Configure Update Mode independently on the software policy that needs maintenance."}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-[#69817c]">
                        <span className="inline-flex items-center gap-1.5">
                          <Clock3 size={13} />
                          Normal close-on-start: <b className="text-[#3d5c59]">30 sec</b>
                        </span>
                        <span className="text-[#b0bfba]">→</span>
                        <span className="inline-flex items-center gap-1.5">
                          <Activity size={13} />
                          Update Mode: <b className={updateMode ? "text-[#24775f]" : "text-[#3d5c59]"}>8 sec</b>
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-pressed={updateMode}
                    onClick={() => setUpdateMode((current) => !current)}
                    className={`relative inline-flex h-9 w-[158px] shrink-0 items-center rounded-full p-1 transition-colors ${
                      updateMode ? "bg-[#277b64]" : "bg-[#aebfba]"
                    }`}
                  >
                    <span
                      className={`absolute flex size-7 items-center justify-center rounded-full bg-[#fbfdfb] shadow-[0_2px_5px_rgba(30,65,60,.22)] transition-transform ${
                        updateMode ? "translate-x-[122px]" : "translate-x-0"
                      }`}
                    >
                      {updateMode ? <Check size={14} className="text-[#2d8069]" /> : <span className="size-1.5 rounded-full bg-[#aebfba]" />}
                    </span>
                    <span className={`w-full text-center text-[11px] font-bold ${updateMode ? "pr-5 text-[#effaf5]" : "pl-5 text-[#f6fbf8]"}`}>
                      {updateMode ? "Disable mode" : "Enable mode"}
                    </span>
                  </button>
                </div>
                {updateMode && (
                  <div className="flex items-center gap-2 border-t border-[#cde2d8] bg-[#d9eee4] px-5 py-2.5 text-[11px] font-semibold text-[#347661] md:px-6">
                    <Activity size={14} className="animate-pulse" />
                    Update Mode is live across 48 computers · started by Alex Kim just now
                  </div>
                )}
              </section>

              <section className="cc-rise cc-delay-2 mt-6 grid gap-4 rounded-2xl border border-[#dfe8e4] bg-[#f9fbf9] px-5 py-5 shadow-[0_8px_24px_rgba(45,73,65,.035)] md:grid-cols-4 md:px-6">
                <Metric label="Managed computers" value="48" detail="across 6 groups" icon={Laptop} tone="teal" />
                <Metric label="Reporting now" value="45" detail="93.8% of estate" icon={Wifi} tone="blue" />
                <Metric label="Policy checks" value="126" detail="12 applications" icon={Settings2} tone="slate" />
                <Metric label="Need attention" value="3" detail="2 offline · 1 stale" icon={AlertTriangle} tone="orange" />
              </section>

              <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,.75fr)]">
                <section className="cc-rise cc-delay-3 min-w-0 overflow-hidden rounded-2xl border border-[#dfe8e4] bg-[#f9fbf9] shadow-[0_8px_24px_rgba(45,73,65,.035)]">
                  <div className="flex flex-col gap-4 border-b border-[#e5ece9] px-5 py-5 md:flex-row md:items-center md:justify-between md:px-6">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-['Space_Grotesk'] text-[18px] font-semibold tracking-[-0.035em] text-[#263d40]">
                          Computer estate
                        </h2>
                        <span className="rounded-full bg-[#e8f1ed] px-2 py-0.5 text-[10px] font-bold text-[#4d8177]">hostnames</span>
                      </div>
                      <p className="mt-1 text-xs text-[#8a9899]">Identity and sync health by computer name</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowOnlyAttention((current) => !current)}
                      className={`inline-flex items-center gap-2 self-start rounded-lg border px-3 py-2 text-xs font-semibold transition-colors md:self-auto ${
                        showOnlyAttention
                          ? "border-[#d9b79f] bg-[#fff1e7] text-[#a96040]"
                          : "border-[#dbe6e2] bg-[#f9fbf9] text-[#66807c] hover:bg-[#edf5f1]"
                      }`}
                    >
                      <Filter size={14} />
                      {showOnlyAttention ? "Showing attention" : "Filter attention"}
                    </button>
                  </div>
                  <div className="flex flex-col gap-3 border-b border-[#e8efec] px-5 py-3.5 sm:flex-row md:px-6">
                    <div className="relative flex-1">
                      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#91a09f]" />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search hostname or group"
                        className="h-9 w-full rounded-lg border border-[#dce7e2] bg-[#f5f8f6] pl-9 pr-3 text-xs text-[#385359] outline-none transition-colors placeholder:text-[#a0acab] focus:border-[#8fbbb0] focus:bg-[#fbfdfb]"
                      />
                    </div>
                    <div className="flex items-center gap-2 rounded-lg bg-[#eff5f2] px-3 text-[11px] font-semibold text-[#64817c]">
                      <span className="size-1.5 rounded-full bg-[#4e9a85]" />
                      Live sync stream
                    </div>
                  </div>
                  <div className="hidden grid-cols-[minmax(170px,1.1fr)_minmax(130px,1fr)_105px_118px_76px] gap-3 bg-[#f1f6f3] px-6 py-2.5 text-[10px] font-bold uppercase tracking-[0.13em] text-[#91a09f] md:grid">
                    <div>Hostname</div>
                    <div>Group</div>
                    <div>Status</div>
                    <div>Last sync</div>
                    <div className="text-right">Pending</div>
                  </div>
                  <div>
                    {filteredHosts.map((host) => (
                      <button
                        type="button"
                        key={host.hostname}
                        onClick={() => setSelectedHost(host)}
                        className="group grid w-full grid-cols-1 gap-2 border-b border-[#edf1ef] px-5 py-4 text-left transition-colors hover:bg-[#f1f7f4] md:grid-cols-[minmax(170px,1.1fr)_minmax(130px,1fr)_105px_118px_76px] md:items-center md:gap-3 md:px-6"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#edf3f1] text-[#6d8985]">
                            <Laptop size={15} />
                          </div>
                          <div>
                            <div className="font-mono text-[12px] font-semibold tracking-[-0.01em] text-[#355158]">{host.hostname}</div>
                            <div className="mt-0.5 text-[10px] text-[#9ba6a6] md:hidden">{host.group}</div>
                          </div>
                          <ArrowUpRight size={14} className="ml-auto text-[#b2c0bd] opacity-0 transition-opacity group-hover:opacity-100 md:hidden" />
                        </div>
                        <div className="hidden truncate text-[11px] text-[#7c8d90] md:block">{host.group}</div>
                        <div><StatusPill status={host.status} /></div>
                        <div className="flex items-center gap-1.5 text-[11px] text-[#76898d]">
                          <Clock3 size={13} className="text-[#a0aeac]" />
                          {host.lastSync}
                        </div>
                        <div className="flex items-center justify-between text-[11px] md:justify-end">
                          <span className="text-[#9ba7a6] md:hidden">Pending updates</span>
                          <span className={`font-mono font-semibold ${host.pending > 2 ? "text-[#b36140]" : "text-[#66817c]"}`}>{host.pending}</span>
                        </div>
                      </button>
                    ))}
                    {!filteredHosts.length && (
                      <div className="px-6 py-10 text-center">
                        <Search size={22} className="mx-auto text-[#b8c6c1]" />
                        <div className="mt-3 text-sm font-semibold text-[#627b7a]">No computers match that search</div>
                        <div className="mt-1 text-xs text-[#9aa8a5]">Try a hostname, group, or clear the attention filter.</div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between bg-[#f5f8f6] px-5 py-3 md:px-6">
                    <span className="text-[11px] text-[#899795]">Showing {filteredHosts.length} of 48 computers</span>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveSection("Computers");
                        setSearch("");
                        setShowOnlyAttention(false);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-[#4d8176] hover:text-[#28675f]"
                    >
                      View all computers <ArrowUpRight size={13} />
                    </button>
                  </div>
                </section>

                <div className="flex min-w-0 flex-col gap-6">
                  <section className="cc-rise cc-delay-4 overflow-hidden rounded-2xl border border-[#dfe8e4] bg-[#f9fbf9] shadow-[0_8px_24px_rgba(45,73,65,.035)]">
                    <div className="flex items-start justify-between border-b border-[#e5ece9] px-5 py-5">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-['Space_Grotesk'] text-[18px] font-semibold tracking-[-0.035em] text-[#263d40]">Transport security</h2>
                          <ShieldCheck size={16} className="text-[#4b907b]" />
                        </div>
                        <p className="mt-1 text-xs text-[#8a9899]">One shared API key for client transport</p>
                      </div>
                      <span className="rounded-full bg-[#e5f2ec] px-2 py-1 text-[10px] font-bold text-[#3e806f]">Secured</span>
                    </div>
                    <div className="px-5 py-4">
                      <div className="rounded-xl border border-[#dbe8e2] bg-[#f1f7f3] p-3.5">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#78928c]">
                          <KeyRound size={14} />
                          Shared client API key
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span className="font-mono text-[13px] tracking-[0.12em] text-[#466660]">nk_live_••••••••••42</span>
                          <span className="rounded-md bg-[#deece6] px-1.5 py-1 text-[10px] text-[#5f827c]">masked</span>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#9aa6a4]">Last rotation</div>
                          <div className="mt-1 text-xs font-semibold text-[#566e70]">{rotated ? "Just now" : "12 Apr 2025"}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#9aa6a4]">Used by</div>
                          <div className="mt-1 text-xs font-semibold text-[#566e70]">48 computers</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRotateOpen(true)}
                        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#d9a98f] bg-[#fff8f3] px-3 py-2.5 text-xs font-bold text-[#a45d3e] transition-colors hover:bg-[#fff0e7]"
                      >
                        <RotateCw size={14} />
                        Rotate shared API key
                      </button>
                      <div className="mt-3 flex items-start gap-2 text-[10px] leading-4 text-[#98a5a3]">
                        <LockKeyhole size={13} className="mt-0.5 shrink-0 text-[#89a39c]" />
                        The new key will be shown only as a masked value. Clients reconnect on their next sync.
                      </div>
                    </div>
                  </section>

                  <section className="overflow-hidden rounded-2xl border border-[#dfe8e4] bg-[#f9fbf9] shadow-[0_8px_24px_rgba(45,73,65,.035)]">
                    <div className="flex items-center justify-between border-b border-[#e5ece9] px-5 py-5">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-['Space_Grotesk'] text-[18px] font-semibold tracking-[-0.035em] text-[#263d40]">Policy coverage</h2>
                          <span className="font-mono text-[11px] text-[#8f9e9d]">3 / 12 shown</span>
                        </div>
                        <p className="mt-1 text-xs text-[#8a9899]">Application-first checks</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveSection("Applications")}
                        className="rounded-lg p-2 text-[#79918c] hover:bg-[#edf5f1] hover:text-[#3c7168]"
                        aria-label="Open application policies"
                      >
                        <ArrowUpRight size={16} />
                      </button>
                    </div>
                    <div className="space-y-3 px-5 py-4">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#788c8d]">Protected applications</span>
                        <span className="font-mono text-xs font-semibold text-[#397663]">10</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[#e7eeeb]">
                        <div className="h-full w-[83%] rounded-full bg-[#6ead99]" />
                      </div>
                      <div className="flex items-center justify-between pt-1 text-[11px]">
                        <span className="inline-flex items-center gap-1.5 text-[#708584]"><CircleCheck size={13} className="text-[#4c987d]" /> 118 checks passing</span>
                        <span className="text-[#aa6b50]">8 need review</span>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              <section className="cc-rise cc-delay-4 mt-6 overflow-hidden rounded-2xl border border-[#dfe8e4] bg-[#f9fbf9] shadow-[0_8px_24px_rgba(45,73,65,.035)]">
                <div className="flex flex-col gap-3 border-b border-[#e5ece9] px-5 py-5 md:flex-row md:items-center md:justify-between md:px-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-['Space_Grotesk'] text-[18px] font-semibold tracking-[-0.035em] text-[#263d40]">Application policies</h2>
                      <span className="rounded-full bg-[#eef4f1] px-2 py-0.5 text-[10px] font-bold text-[#6c8984]">Application-first model</span>
                    </div>
                    <p className="mt-1 text-xs text-[#8a9899]">EXE version checks and INI values grouped under each application</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const first = policies[0];
                      if (first) openPolicyEditor(first);
                    }}
                    className="inline-flex items-center gap-2 self-start rounded-lg border border-[#d8e5df] bg-[#f9fcfa] px-3 py-2 text-xs font-bold text-[#4e7c73] hover:border-[#a9c8be] hover:bg-[#edf5f1]"
                  >
                    <SlidersHorizontal size={14} />
                    Manage policies
                  </button>
                </div>
                <div>
                  {policies.map((policy) => (
                    <PolicyRow
                      key={policy.id}
                      policy={policy}
                      expanded={expandedPolicies.includes(policy.id)}
                      onToggle={() => togglePolicy(policy.id)}
                      onEdit={() => openPolicyEditor(policy)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 bg-[#f1f6f3] px-5 py-3 text-[11px] text-[#829492] md:px-6">
                  <Eye size={14} className="text-[#70938a]" />
                  Each application can carry multiple executable and INI checks. Expand a row to inspect the complete policy.
                </div>
              </section>

              <footer className="flex flex-col gap-2 py-8 text-[10px] text-[#98a5a3] sm:flex-row sm:items-center sm:justify-between">
                <span>NemesysV2 Control Center · Fleet policy service</span>
                <span className="font-mono">build 2.8.4 / EU-1 / {lastChecked}</span>
              </footer>
            </div>
          </div>
        </main>
      </div>

      {rotateOpen && (
        <ModalShell eyebrow="Administrator action" title="Rotate shared API key?" onClose={() => setRotateOpen(false)}>
          <div className="px-6 py-5">
            <div className="flex items-start gap-3 rounded-xl border border-[#edd5c5] bg-[#fff4ec] p-3.5">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[#b5633f]" />
              <p className="text-xs leading-5 text-[#7f6255]">
                Rotating this key will invalidate the current transport credential. All 48 clients will receive the new masked key at their next sync.
              </p>
            </div>
            <div className="mt-5 space-y-2 text-xs text-[#708184]">
              <div className="flex justify-between gap-4"><span>Current key</span><span className="font-mono text-[#506b6b]">nk_live_••••••••••42</span></div>
              <div className="flex justify-between gap-4"><span>New key display</span><span className="font-mono text-[#506b6b]">nk_live_••••••••••73</span></div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setRotateOpen(false)} className="rounded-lg px-3.5 py-2.5 text-xs font-semibold text-[#738486] hover:bg-[#edf3f0]">Cancel</button>
              <button type="button" onClick={confirmRotation} className="inline-flex items-center gap-2 rounded-lg bg-[#b66440] px-4 py-2.5 text-xs font-bold text-[#fff8f3] shadow-[0_5px_12px_rgba(182,100,64,.16)] hover:bg-[#a95838]">
                <RotateCw size={14} />
                Confirm rotation
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {selectedHost && (
        <ModalShell eyebrow="Computer sync detail" title={selectedHost.hostname} onClose={() => setSelectedHost(null)}>
          <div className="px-6 py-5">
            <div className="flex items-center justify-between rounded-xl bg-[#edf5f1] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <Laptop size={17} className="text-[#4b8578]" />
                <div>
                  <div className="font-mono text-xs font-semibold text-[#3f6262]">{selectedHost.ip}</div>
                  <div className="mt-0.5 text-[10px] text-[#8a9d99]">{selectedHost.group}</div>
                </div>
              </div>
              <StatusPill status={selectedHost.status} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-[#e1ebe6] p-3.5">
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9aa7a4]">Last successful sync</div>
                <div className="mt-2 font-['Space_Grotesk'] text-[15px] font-semibold text-[#3b585d]">{selectedHost.syncDetail}</div>
              </div>
              <div className="rounded-xl border border-[#e1ebe6] p-3.5">
                <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9aa7a4]">Agent / pending</div>
                <div className="mt-2 font-['Space_Grotesk'] text-[15px] font-semibold text-[#3b585d]">v{selectedHost.agent} <span className="text-[#b36749]">· {selectedHost.pending} updates</span></div>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2 border-t border-[#e6ece9] pt-4 text-[11px] text-[#81908f]">
              <ShieldCheck size={14} className="text-[#55927e]" />
              Identity is verified by hostname and the shared API key transport.
            </div>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setSelectedHost(null)} className="rounded-lg bg-[#2d6e65] px-4 py-2.5 text-xs font-bold text-[#effaf5] hover:bg-[#245e58]">Done</button>
            </div>
          </div>
        </ModalShell>
      )}

      {editingPolicy && (
        <ModalShell eyebrow="Application policy" title={`Edit ${editingPolicy.name}`} onClose={() => setEditingPolicy(null)}>
          <div className="px-6 py-5">
            <div className="rounded-xl border border-[#dce8e3] bg-[#f2f7f4] p-3.5 text-xs leading-5 text-[#718482]">
              Update the overview fields here. The checks below remain grouped under this application and are evaluated on each matching hostname.
            </div>
            <label className="mt-5 block text-[11px] font-bold uppercase tracking-[0.12em] text-[#819390]">
              Application name
              <input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-[#d8e5df] bg-[#fbfdfb] px-3 text-sm font-semibold text-[#38565a] outline-none focus:border-[#83b5a8]" />
            </label>
            <label className="mt-4 block text-[11px] font-bold uppercase tracking-[0.12em] text-[#819390]">
              Scope
              <input value={editScope} onChange={(event) => setEditScope(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-[#d8e5df] bg-[#fbfdfb] px-3 text-sm text-[#536d70] outline-none focus:border-[#83b5a8]" />
            </label>
            <div className="mt-5 rounded-xl border border-[#e3ebe7] p-3.5">
              <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.11em] text-[#819390]">
                <span>Checks in policy</span>
                <span className="font-mono text-[#4c8276]">{editingPolicy.exes.length + editingPolicy.ini.length}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {editingPolicy.exes.map((check) => <span key={check.file} className="rounded-md bg-[#edf5f1] px-2 py-1 font-mono text-[10px] text-[#47746d]">{check.file} {check.operator} {check.version}</span>)}
                {editingPolicy.ini.map((check) => <span key={check.key} className="rounded-md bg-[#fff0e7] px-2 py-1 font-mono text-[10px] text-[#a86143]">{check.key}={check.value}</span>)}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingPolicy(null)} className="rounded-lg px-3.5 py-2.5 text-xs font-semibold text-[#738486] hover:bg-[#edf3f0]">Cancel</button>
              <button type="button" onClick={savePolicy} className="inline-flex items-center gap-2 rounded-lg bg-[#2d6e65] px-4 py-2.5 text-xs font-bold text-[#effaf5] hover:bg-[#245e58]">
                <Save size={14} />
                Save policy
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}