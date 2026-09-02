import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Download, ShieldCheck, X } from "lucide-react";

export function CloseWarning() {
  const [seconds, setSeconds] = useState(28);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value > 0 ? value - 1 : 28), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const progress = Math.max(0, Math.min(100, (seconds / 28) * 100));

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef2f6] p-8 font-['Segoe_UI',Arial,sans-serif] text-[#1b1b1b]">
      <section className="w-full max-w-[610px] overflow-hidden rounded-[10px] border border-[#c9d1da] bg-white shadow-[0_18px_48px_rgba(28,46,64,.16),0_3px_10px_rgba(28,46,64,.08)]">
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

        <div className="px-7 pb-7 pt-6">
          <div className="flex gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] bg-[#fff1d6] text-[#b36a00]">
              <AlertTriangle size={23} strokeWidth={2.2} />
            </div>
            <div>
              <h1 className="text-[21px] font-semibold leading-[1.2] tracking-[-.025em] text-[#17212b]">
                BlueHarbor needs to close
              </h1>
              <p className="mt-2 max-w-[470px] text-[13px] leading-[1.55] text-[#566572]">
                NemesysV2 is ready to install an update. Please save your work. The application will close automatically so the update can continue.
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-[8px] border border-[#dce3e9] bg-[#f8fafc] p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[7px] bg-[#295f94] text-[14px] font-bold text-white">BH</div>
                <div>
                  <div className="text-[13px] font-semibold text-[#293640]">BlueHarbor.exe</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#73818d]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#e2a01d]" />
                    Running · Unsaved changes may be lost
                  </div>
                </div>
              </div>
              <div className="rounded-full bg-[#fff1d6] px-2.5 py-1 text-[10px] font-semibold text-[#996000]">Update required</div>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e5eaf0]">
              <div className="h-full rounded-full bg-[#d58b18] transition-all duration-1000" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-[#a35e00]">
            <Clock3 size={18} />
            <span className="text-[14px] font-semibold">Closing in 00:{String(seconds).padStart(2, "0")}</span>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-2 border-y border-[#e8edf1] py-4">
            <div className="flex flex-col items-center gap-1 text-center">
              <CheckCircle2 size={16} className="text-[#0b8952]" />
              <span className="text-[10px] leading-[1.35] text-[#64727d]">Update downloaded</span>
            </div>
            <div className="flex flex-col items-center gap-1 border-x border-[#e8edf1] text-center">
              <Download size={16} className="text-[#3972a4]" />
              <span className="text-[10px] leading-[1.35] text-[#64727d]">Install starts after close</span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <ShieldCheck size={16} className="text-[#0b8952]" />
              <span className="text-[10px] leading-[1.35] text-[#64727d]">Your settings stay intact</span>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2.5">
            <button className="rounded-[5px] border border-[#c8d1da] bg-white px-4 py-2 text-[12px] font-semibold text-[#43515d] shadow-[0_1px_1px_rgba(0,0,0,.03)] hover:bg-[#f6f8fa]">
              Remind me later
            </button>
            <button className="rounded-[5px] bg-[#087647] px-5 py-2 text-[12px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,.12)] hover:bg-[#07653c]">
              Close application now
            </button>
          </div>
          <p className="mt-3 text-right text-[10px] text-[#87939d]">The update will resume automatically after the application closes.</p>
        </div>
      </section>
    </main>
  );
}