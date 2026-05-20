import React from "react";
import { 
  ArrowLeft, CheckCircle2, Check, ThumbsUp, ThumbsDown, Lock, RefreshCw, Plus, Printer, 
  PanelLeftClose, Search, MoreHorizontal, Globe, Trash2, AlertTriangle, LifeBuoy
} from "lucide-react";

export function SoftClinical() {
  return (
    <div className="min-h-screen w-full flex flex-col font-['Plus_Jakarta_Sans'] bg-[#F6F8F7] text-[#2F3B36] selection:bg-[#E5ECE9]">
      <style dangerouslySetInnerHTML={{
        __html: `
          .soft-border { border-color: #E6EBE9; }
          .soft-divide > * + * { border-color: #E6EBE9; }
          .font-mono-num { font-family: 'Geist Mono', monospace; font-weight: 300; letter-spacing: -0.02em; }
        `
      }} />

      {/* 1. Top app bar */}
      <header className="sticky top-0 z-20 flex h-[60px] w-full items-center justify-between border-b soft-border bg-white/95 px-6 backdrop-blur-sm">
        <div className="flex items-center gap-6">
          <img src="/__mockup/images/kfi-logo-transparent.png" alt="KFI Staffing" className="h-[28px] opacity-90 mix-blend-multiply" />
          <button className="flex items-center gap-2 text-sm font-medium tracking-wide text-[#6A7C75] hover:text-[#2F3B36] transition-colors">
            <ArrowLeft className="h-4 w-4 stroke-[1.5]" />
            Back
          </button>
        </div>

        <div className="flex items-center gap-1.5 rounded-full border soft-border bg-[#FBFDFD] p-1 shadow-sm shadow-[#E6EBE9]/20">
          <div className="flex items-center rounded-full bg-white px-3 py-1.5 text-xs font-semibold tracking-wider text-[#2F3B36] shadow-sm soft-border border">
            EN
          </div>
          <div className="flex items-center px-3 py-1.5 text-xs font-medium tracking-wider text-[#8A9C95] hover:text-[#2F3B36] cursor-pointer transition-colors">
            ES
          </div>
          <div className="h-4 w-px bg-[#E6EBE9] mx-1"></div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#4B5E55]">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#7CA38F]" />
            <span className="font-mono-num mt-[1px]">17 / 18</span> reviewed
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#4B5E55]">
            <Check className="h-3.5 w-3.5 text-[#A5B8B0]" />
            <span className="font-mono-num mt-[1px]">0 / 18</span> punches
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded border soft-border p-1 bg-[#FBFDFD]">
            <button className="flex items-center gap-1.5 rounded bg-[#EAF0ED] px-3 py-1.5 text-xs font-medium text-[#2F3B36] transition-colors">
              <ThumbsUp className="h-3.5 w-3.5 stroke-[2] text-[#7CA38F]" /> Good
            </button>
            <button className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-[#8A9C95] hover:bg-[#F2F6F4] transition-colors">
              <ThumbsDown className="h-3.5 w-3.5 stroke-[1.5]" /> Bad
            </button>
          </div>
          <div className="h-6 w-px bg-[#E6EBE9]"></div>
          <button className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-[#6A7C75] hover:bg-white transition-colors">
            <Lock className="h-3.5 w-3.5 stroke-[1.5]" /> Lock
          </button>
          <button className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-[#6A7C75] hover:bg-white transition-colors">
            <RefreshCw className="h-3.5 w-3.5 stroke-[1.5]" /> Refresh
          </button>
          <button className="flex items-center gap-1.5 rounded-md bg-[#2F3B36] px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-[#1E2623] transition-colors">
            <Plus className="h-3.5 w-3.5" /> Add Punch
          </button>
          <button className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-[#6A7C75] hover:bg-white transition-colors ml-1">
            <Printer className="h-3.5 w-3.5 stroke-[1.5]" /> Print
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 2. Sidebar */}
        <aside className="w-[280px] shrink-0 border-r soft-border bg-[#FCFDFD] flex flex-col">
          <div className="flex h-14 items-center justify-between px-5 border-b soft-border">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Drivers by Customer</h2>
            <button className="text-[#A5B8B0] hover:text-[#6A7C75]">
              <PanelLeftClose className="h-4 w-4 stroke-[1.5]" />
            </button>
          </div>
          
          <div className="p-4 border-b soft-border space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#A5B8B0]" />
              <input 
                type="text" 
                placeholder="Search name or KFI ID" 
                className="w-full rounded border soft-border bg-white py-1.5 pl-8 pr-3 text-xs text-[#2F3B36] placeholder:text-[#A5B8B0] focus:border-[#A5B8B0] focus:outline-none focus:ring-1 focus:ring-[#A5B8B0]/20"
              />
            </div>
            <div className="flex">
              <button className="rounded-full border soft-border bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[#8A9C95] hover:border-[#A5B8B0]">
                Un-reviewed
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <CustomerGroup name="ADIENT" count={1} drivers={[
              { name: "Jose Angulo Alfaro", ot: true }
            ]} />
            <CustomerGroup name="SCHUETTE METALS" count={1} drivers={[
              { name: "Giovanni Alexander" }
            ]} />
            <CustomerGroup name="BURNETT DAIRY - GRANTSBURG" count={3} drivers={[
              { name: "Felix Baez Caballero" },
              { name: "Isidro Guerrero" },
              { name: "Willie Medina" }
            ]} />
            <CustomerGroup name="DELALLO" count={2} drivers={[
              { name: "Cory Brittman", ot: true },
              { name: "Davidson Alcide", ot: true }
            ]} />
            <CustomerGroup name="INTERNATIONAL WIRE" count={1} drivers={[
              { name: "Jonathan Cedeno Mendez" }
            ]} />
            <CustomerGroup name="KFI STAFFING" count={1} drivers={[
              { name: "William Mejia" }
            ]} />
            <CustomerGroup name="LANDSCAPE STRUCTURES" count={3} drivers={[
              { name: "Benjamin Rodriguez Gonzalez", ot: true, active: true },
              { name: "Sebastian Villarreal" },
              { name: "Tyrek Patterson" }
            ]} />
            <CustomerGroup name="PENDA CORP" count={2} drivers={[]} />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto flex flex-col">
          {/* 3. Page header band */}
          <div className="bg-white border-b soft-border px-8 pt-10 pb-8 flex justify-between items-end">
            <div>
              <h1 className="text-3xl font-light tracking-tight text-[#1A211F] mb-3">Benjamin Rodriguez Gonzalez</h1>
              <div className="flex items-center gap-3 text-xs text-[#6A7C75] font-mono-num mb-4">
                <span>Customer: <span className="font-['Plus_Jakarta_Sans'] font-medium text-[#2F3B36]">Landscape Structures</span></span>
                <span className="text-[#C1CDCE]">•</span>
                <span>KFI ID: 2003681</span>
                <span className="text-[#C1CDCE]">•</span>
                <span className="flex items-center gap-1.5 rounded-full border soft-border px-2.5 py-0.5 bg-[#FBFDFD] font-['Plus_Jakarta_Sans'] text-[11px] font-medium">
                  <Globe className="h-3 w-3 text-[#8A9C95]" /> America/Chicago
                </span>
                <span className="text-[#C1CDCE]">•</span>
                <span className="rounded-full border soft-border px-2.5 py-0.5 bg-[#FBFDFD] font-['Plus_Jakarta_Sans'] text-[11px] font-medium">
                  Landscape Structures: America/Chicago
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs font-medium text-[#6A7C75]">
                <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-[#2F3B36]" /> Driver (Connecteam)</div>
                <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-[#528C8A]" /> Customer (Timesheet)</div>
                <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-[#C2936B]" /> Overtime threshold</div>
              </div>
            </div>
            
            <div className="flex gap-3">
              <button className="flex items-center gap-1.5 rounded-md border border-[#E9D9D9] px-3 py-1.5 text-xs font-medium text-[#AA5555] hover:bg-[#FDF9F9] transition-colors">
                <Trash2 className="h-3.5 w-3.5 stroke-[1.5]" /> Remove Connecteam time
              </button>
              <button className="flex items-center gap-1.5 rounded-md border border-[#E9D9D9] px-3 py-1.5 text-xs font-medium text-[#AA5555] hover:bg-[#FDF9F9] transition-colors">
                <Trash2 className="h-3.5 w-3.5 stroke-[1.5]" /> Reset customer punches
              </button>
            </div>
          </div>

          <div className="p-8 pb-16 max-w-[1200px] w-full">
            {/* 4. Two-up panels */}
            <div className="grid grid-cols-2 gap-8 mb-8">
              {/* Summary panel */}
              <div className="rounded-xl border soft-border bg-white shadow-sm shadow-[#E6EBE9]/30 overflow-hidden">
                <div className="flex h-12 items-center justify-between border-b soft-border px-5 bg-[#FCFDFD]">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#4B5E55]">Summary</h3>
                  <div className="flex items-center gap-1.5 rounded-md bg-[#FFF9ED] px-2.5 py-1 text-[11px] font-medium text-[#A67D3A] border border-[#FDEBCE]">
                    <AlertTriangle className="h-3 w-3" /> DIFFERS FROM CONNECTEAM (4)
                  </div>
                </div>
                <div className="flex flex-col soft-divide divide-y px-5 py-2">
                  <SummaryRow label="Total Driver" value="6.39" />
                  <SummaryRow label="Total Customer" value="40.23" />
                  <SummaryRow label="Total Hours" value="46.62" />
                  <SummaryRow label="Customer RT" value="34.23" />
                  <SummaryRow label="Customer OT" value="6.00" warn />
                  <SummaryRow label="Driver RT" value="5.77" />
                  <SummaryRow label="Driver OT" value="0.62" warn />
                </div>
              </div>

              {/* Checks panel */}
              <div className="rounded-xl border soft-border bg-white shadow-sm shadow-[#E6EBE9]/30 overflow-hidden">
                <div className="flex h-12 items-center gap-2 border-b border-[#E1EDE8] px-5 bg-[#F4F9F6]">
                  <CheckCircle2 className="h-4 w-4 text-[#5F8B76]" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#3D5A4C]">Checks — all reconcile</h3>
                </div>
                <div className="flex flex-col soft-divide divide-y px-5 py-2">
                  <CheckRow label="Total = Driver + Customer" value="46.62" />
                  <CheckRow label="Customer = Total - Driver" value="40.23" />
                  <CheckRow label="Driver = Total - Customer" value="6.39" />
                  <CheckRow label="Customer RT + Driver RT = RT" value="40.00" />
                  <CheckRow label="Customer OT + Driver OT = OT" value="6.62" />
                  <CheckRow label="RT + OT = Total" value="46.62" />
                </div>
              </div>
            </div>

            {/* 5. Punches table */}
            <div className="rounded-xl border soft-border bg-white shadow-sm shadow-[#E6EBE9]/30 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#FCFDFD] border-b soft-border">
                  <tr>
                    <th className="px-5 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Date</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Source</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Clock In</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Clock Out</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Hours</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Running</th>
                    <th className="px-4 py-3.5 text-[10px] font-bold uppercase tracking-widest text-[#8A9C95]">Type</th>
                    <th className="px-5 py-3.5 text-right"></th>
                  </tr>
                </thead>
                <tbody className="soft-divide divide-y">
                  <PunchRow date="2026-05-11" source="DRIVER" edited clockIn="05/11, 12:32 PM" clockOut="05/11, 1:20 PM" hours="0.80" running="0.80" type="Driver" />
                  <PunchRow date="2026-05-11" source="CUSTOMER" clockIn="05/11, 1:28 PM" clockOut="05/11, 6:40 PM" hours="5.20" running="6.00" type="Customer" />
                  <PunchRow date="2026-05-11" source="CUSTOMER" clockIn="05/11, 7:10 PM" clockOut="05/12, 12:00 AM" hours="4.83" running="10.83" type="Customer" />
                  <PunchRow date="2026-05-12" source="DRIVER" edited clockIn="05/12, 12:00 AM" clockOut="05/12, 12:29 AM" hours="0.48" running="11.31" type="Driver" />
                  <PunchRow date="2026-05-12" source="DRIVER" clockIn="05/12, 12:32 PM" clockOut="05/12, 1:16 PM" hours="0.73" running="12.04" type="Driver" />
                  <PunchRow date="2026-05-12" source="CUSTOMER" clockIn="05/12, 1:26 PM" clockOut="05/12, 6:38 PM" hours="5.20" running="17.24" type="Customer" />
                  <PunchRow date="2026-05-13" source="DRIVER" clockIn="05/13, 12:01 PM" clockOut="05/13, 12:48 PM" hours="0.78" running="18.02" type="Driver" />
                  <PunchRow date="2026-05-13" source="CUSTOMER" clockIn="05/13, 12:53 PM" clockOut="05/13, 6:42 PM" hours="5.82" running="23.84" type="Customer" />
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      {/* 6. Floating help button */}
      <button className="fixed bottom-6 right-6 flex h-12 w-12 items-center justify-center rounded-full bg-[#7FA192] text-white shadow-lg shadow-[#7FA192]/30 hover:bg-[#6A8B7D] hover:-translate-y-0.5 transition-all">
        <LifeBuoy className="h-5 w-5 stroke-[1.5]" />
      </button>
    </div>
  );
}

// Subcomponents

function CustomerGroup({ name, count, drivers }: { name: string, count: number, drivers: any[] }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-5 py-1.5">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#2F3B36]">{name}</h4>
        <span className="rounded-full bg-[#EAF0ED] px-2 py-0.5 text-[9px] font-bold text-[#6A7C75]">{count}</span>
      </div>
      <ul className="mt-1">
        {drivers.map((d, i) => (
          <li key={i} className={`flex items-center justify-between px-5 py-2 cursor-pointer group ${d.active ? 'bg-[#EEF4F1] border-l-2 border-[#7CA38F]' : 'border-l-2 border-transparent hover:bg-[#FBFDFD]'}`}>
            <div className="flex items-center gap-3">
              <div className={`h-2.5 w-2.5 rounded-full ${d.active ? 'bg-[#7CA38F]' : 'border-2 border-[#D1DCD8]'}`} />
              <span className={`text-xs ${d.active ? 'font-medium text-[#1A211F]' : 'text-[#4B5E55]'}`}>{d.name}</span>
            </div>
            <div className="flex items-center gap-2">
              {d.ot && <span className="rounded border border-[#F2DECE] bg-[#FFFBF5] px-1.5 py-0.5 text-[9px] font-bold text-[#A67D3A]">OT</span>}
              <MoreHorizontal className={`h-4 w-4 ${d.active ? 'text-[#8A9C95]' : 'text-[#D1DCD8] opacity-0 group-hover:opacity-100'}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryRow({ label, value, warn }: { label: string, value: string, warn?: boolean }) {
  return (
    <div className="flex justify-between py-2.5">
      <span className="text-xs font-medium text-[#6A7C75]">{label}</span>
      <span className={`text-xs font-mono-num ${warn ? 'text-[#C2936B] font-medium' : 'text-[#2F3B36]'}`}>{value}</span>
    </div>
  );
}

function CheckRow({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex justify-between py-2.5">
      <div className="flex items-center gap-2.5">
        <Check className="h-3 w-3 text-[#A5B8B0]" />
        <span className="text-xs font-mono-num text-[#6A7C75]">{label}</span>
      </div>
      <span className="text-xs font-mono-num text-[#2F3B36]">{value}</span>
    </div>
  );
}

function PunchRow({ date, source, edited, clockIn, clockOut, hours, running, type }: any) {
  const isDriver = type === 'Driver';
  return (
    <tr className="group hover:bg-[#FBFDFD] transition-colors">
      <td className="px-5 py-3 whitespace-nowrap text-[11px] font-mono-num text-[#6A7C75]">{date}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex flex-col items-start">
          <span className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[9px] font-bold tracking-widest ${isDriver ? 'bg-[#2F3B36] text-[#EAF0ED]' : 'bg-[#528C8A] text-[#EAF6F5]'}`}>
            {source}
          </span>
          {edited && <span className="mt-0.5 text-[8px] font-bold tracking-wider text-[#A5B8B0] ml-0.5">EDITED</span>}
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-[11px] font-mono-num text-[#2F3B36]">{clockIn}</td>
      <td className="px-4 py-3 whitespace-nowrap text-[11px] font-mono-num text-[#2F3B36]">{clockOut}</td>
      <td className="px-4 py-3 whitespace-nowrap text-[11px] font-mono-num font-medium text-[#2F3B36]">{hours}</td>
      <td className="px-4 py-3 whitespace-nowrap text-[11px] font-mono-num text-[#8A9C95]">{running}</td>
      <td className={`px-4 py-3 whitespace-nowrap text-[11px] ${isDriver ? 'text-[#4B5E55]' : 'text-[#528C8A]'}`}>{type}</td>
      <td className="px-5 py-3 whitespace-nowrap text-right">
        <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button className="h-6 w-6 rounded flex items-center justify-center border soft-border bg-white text-[#8A9C95] hover:text-[#2F3B36] hover:border-[#8A9C95]"><Check className="h-3 w-3" /></button>
          <button className="h-6 px-2 rounded flex items-center justify-center border soft-border bg-white text-[#8A9C95] hover:text-[#2F3B36] hover:border-[#8A9C95] text-[10px] font-medium tracking-wide">Flag</button>
          <button className="h-6 px-2 rounded flex items-center justify-center border soft-border bg-white text-[#8A9C95] hover:text-[#2F3B36] hover:border-[#8A9C95]"><span className="h-3.5 w-3.5 block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg></span></button>
          <button className="h-6 px-2 rounded flex items-center justify-center border soft-border bg-white text-[#8A9C95] hover:text-[#2F3B36] hover:border-[#8A9C95]"><span className="h-3.5 w-3.5 block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></span></button>
          <button className="h-6 px-2 rounded flex items-center justify-center border border-[#F2E5E5] bg-white text-[#C78B8B] hover:text-[#AA5555] hover:border-[#C78B8B]"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </td>
    </tr>
  );
}
