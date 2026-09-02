import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, ShieldCheck, X } from "lucide-react";

export function CloseWarning() {
  const [seconds, setSeconds] = useState(28);
  const [postponeAllowed, setPostponeAllowed] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value > 0 ? value - 1 : 28), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const progress = Math.max(0, Math.min(100, (seconds / 28) * 100));

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef2f6] p-8 font-['Segoe_UI',Arial,sans-serif] text-[#1b1b1b]">
      <div className="w-full max-w-[680px]">
        <div className="mb-3 flex items-center justify-between rounded-[8px] border border-[#c9d5df] bg-[#f8fafc] px-4 py-3 shadow-[0_2px_7px_rgba(28,46,64,.06)]">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[.08em] text-[#557082]">Console policy preview</div>
            <div className="mt-1 text-[12px] text-[#6d7b86]">Application close behavior for BlueHarbor</div>
          </div>
          <button
            aria-pressed={postponeAllowed}
            onClick={() => setPostponeAllowed((value) => !value)}
            className={`flex items-center gap-2 rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${postponeAllowed ? "bg-[#d9f2e6] text-[#087647]" : "bg-[#e9edf1] text-[#65737e]"}`}
          >
            <span className={`relative h-4 w-7 rounded-full transition-colors ${postponeAllowed ? "bg-[#087647]" : "bg-[#aeb9c2]"}`}>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${postponeAllowed ? "translate-x-3.5" : "translate-x-0.5"}`} />
            </span>
            Postpone {postponeAllowed ? "enabled" : "disabled"}
          </button>
        </div>

        <section className="overflow-hidden rounded-[10px] border border-[#c9d1da] bg-white shadow-[0_18px_48px_rgba(28,46,64,.16),0_3px_10px_rgba(28,46,64,.08)]">
          <header className="flex items-center justify-between border-b border-[#e5e9ee] px-7 py-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-[#d9f2e6] text-[#087647]">
                <ShieldCheck size={20} strokeWidth={2.4} />
              </div>
              <div>
                <div className="text-[13px] font-semibold tracking-[-.01em] text-[#29323b]">NemesysV2</div>
                <div className="mt-0.5 text-[11px] text-[#77838e]">Application update service</div>
              </div>
            </div>
            <button aria-label="Close dialog" className="rounded-[5px] p-1.5 text-[#6f7b86] hover:bg-[#f1f4f7]">
              <X size={17} />
            </button>
          </header>

          {closed ? (
            <div className="flex min-h-[330px] flex-col items-center justify-center px-7 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9f2e6] text-[#087647]"><ShieldCheck size={25} /></div>
              <h1 className="mt-4 text-[20px] font-semibold text-[#17212b]">BlueHarbor has been closed</h1>
              <p className="mt-2 max-w-[390px] text-[13px] leading-[1.5] text-[#61707c]">The update can continue now. You can reopen the application when installation is complete.</p>
            </div>
          ) : (
            <div className="px-7 pb-6 pt-6">
              <div className="flex gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] bg-[#fff1d6] text-[#b36a00]"><AlertTriangle size={23} strokeWidth={2.2} /></div>
                <div>
                  <h1 className="text-[21px] font-semibold leading-[1.2] tracking-[-.025em] text-[#17212b]">BlueHarbor needs to close</h1>
                  <p className="mt-2 max-w-[500px] text-[13px] leading-[1.55] text-[#566572]">NemesysV2 is ready to install an update. Please save your work. The application will close automatically so the update can continue.</p>
                </div>
              </div>

              <div className="mt-5 rounded-[8px] border border-[#dce3e9] bg-[#f8fafc] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[7px] bg-[#295f94] text-[14px] font-bold text-white">BH</div>
                    <div>
                      <div className="text-[13px] font-semibold text-[#293640]">BlueHarbor.exe</div>
                       <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#73818d]"><span className="h-1.5 w-1.5 rounded-full bg-[#0b8952]" />Maintenance is running</div>
                    </div>
                  </div>
                  <div className="rounded-full bg-[#fff1d6] px-2.5 py-1 text-[10px] font-semibold text-[#996000]">Update required</div>
                </div>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e5eaf0]"><div className="h-full rounded-full bg-[#d58b18] transition-all duration-1000" style={{ width: `${progress}%` }} /></div>
              </div>

              <div className="mt-5 flex items-center justify-center gap-2 text-[#a35e00]"><Clock3 size={18} /><span className="text-[14px] font-semibold">Closing in 00:{String(seconds).padStart(2, "0")}</span></div>

              <div className="mt-5 flex items-center justify-end gap-2.5 border-t border-[#e8edf1] pt-5">
                {postponeAllowed && <button className="rounded-[5px] border border-[#c8d1da] bg-white px-4 py-2 text-[12px] font-semibold text-[#43515d] shadow-[0_1px_1px_rgba(0,0,0,.03)] hover:bg-[#f6f8fa]">Remind me later</button>}
                <button onClick={() => setClosed(true)} className="rounded-[5px] bg-[#087647] px-5 py-2 text-[12px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,.12)] hover:bg-[#07653c]">Close application now</button>
              </div>
              <p className="mt-3 text-right text-[10px] text-[#87939d]">{postponeAllowed ? "The update will resume automatically after the application closes." : "Postponing is disabled by your administrator."}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}