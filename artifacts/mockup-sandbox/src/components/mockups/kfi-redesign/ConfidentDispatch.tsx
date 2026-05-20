import React from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Check,
  ThumbsUp,
  ThumbsDown,
  Lock,
  RefreshCw,
  Plus,
  Printer,
  PanelLeftClose,
  Search,
  MoreHorizontal,
  Globe,
  Trash2,
  AlertTriangle,
  MessageSquare,
  Pencil,
  LifeBuoy
} from "lucide-react";

export function ConfidentDispatch() {
  return (
    <div
      className="min-h-screen w-full font-['Plus_Jakarta_Sans',sans-serif] text-[#2b2624] flex flex-col antialiased"
      style={{
        backgroundColor: "#f9f6f0", // Warm parchment/ivory
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: `
        :root {
          --rust-900: #4a1c12;
          --rust-800: #6b291a;
          --rust-700: #8c3622;
          --rust-600: #9a3b26; /* Primary */
          --rust-500: #ad422b;
          --rust-400: #c1553d;
          --rust-300: #d47661;
          --rust-200: #e59f8e;
          --rust-100: #f2ccc3;
          --rust-50:  #f9e5e0;

          --ivory-50:  #ffffff;
          --ivory-100: #fdfbf7;
          --ivory-200: #f9f6f0; /* App bg */
          --ivory-300: #f2ebe1; /* Surface */
          --ivory-400: #e6dfd3; /* Borders */
          --ivory-500: #d8cuc0;
          --ivory-600: #bcaea0;
          --ivory-700: #9e9083;
          --ivory-800: #807367;
          --ivory-900: #63584e;

          --text-main: #2b2624;
          --text-muted: #63584e;

          --accent-green: #2e5e4e;
          --accent-green-bg: #e1ede8;
          --accent-teal: #1f6063;
          --accent-amber: #c66a15;
          --accent-amber-bg: #fdf0e3;
        }

        /* Micro-caps badges */
        .badge-rect {
          border-radius: 2px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 700;
          font-size: 0.65rem;
          padding: 0.125rem 0.375rem;
        }
        
        .shadow-warm {
          box-shadow: 0 4px 12px rgba(107, 41, 26, 0.06), 0 1px 3px rgba(107, 41, 26, 0.04);
        }
        
        .table-row-hover:hover {
          background-color: var(--ivory-100);
        }
      `}} />

      {/* 1. Top app bar */}
      <header className="sticky top-0 z-20 flex h-14 w-full items-center justify-between border-b border-[#e6dfd3] bg-[#ffffff] px-4 shadow-sm">
        {/* Left cluster */}
        <div className="flex items-center gap-4">
          <img src="/__mockup/images/kfi-logo-transparent.png" alt="KFI Staffing" className="h-7 w-auto mix-blend-multiply" />
          <div className="h-6 w-[1px] bg-[#e6dfd3]"></div>
          <button className="flex items-center gap-1.5 text-sm font-semibold tracking-wide text-[#63584e] transition-colors hover:text-[#9a3b26]">
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>

        {/* Center cluster */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-sm border border-[#e6dfd3] bg-[#f9f6f0] p-0.5">
            <button className="rounded-[1px] bg-[#ffffff] px-2.5 py-1 text-xs font-bold tracking-wider text-[#2b2624] shadow-sm">EN</button>
            <button className="rounded-[1px] px-2.5 py-1 text-xs font-bold tracking-wider text-[#9e9083] hover:text-[#2b2624]">ES</button>
          </div>
          <div className="h-4 w-[1px] bg-[#e6dfd3] mx-1"></div>
          <div className="flex items-center gap-1.5 rounded-sm bg-[#e1ede8] px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-[#2e5e4e]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            17 / 18 reviewed
          </div>
          <div className="flex items-center gap-1.5 rounded-sm border border-[#e6dfd3] bg-[#ffffff] px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-[#63584e]">
            <Check className="h-3.5 w-3.5 text-[#bcaea0]" />
            0/18 punches
          </div>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center rounded-sm border border-[#e6dfd3] bg-[#f9f6f0] p-0.5">
            <button className="flex items-center gap-1.5 rounded-[1px] bg-[#e1ede8] px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-[#2e5e4e] shadow-sm">
              <ThumbsUp className="h-3.5 w-3.5" />
              Good
            </button>
            <button className="flex items-center gap-1.5 rounded-[1px] px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-[#9e9083] hover:text-[#2b2624]">
              <ThumbsDown className="h-3.5 w-3.5" />
              Bad
            </button>
          </div>
          
          <div className="h-5 w-[1px] bg-[#e6dfd3] mx-1"></div>

          <button className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-[#63584e] hover:bg-[#f2ebe1]">
            <Lock className="h-3.5 w-3.5" />
            Lock
          </button>
          
          <button className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-[#63584e] hover:bg-[#f2ebe1]">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          <button className="flex items-center gap-1.5 rounded-sm bg-[#9a3b26] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-[#8c3622]">
            <Plus className="h-3.5 w-3.5" />
            Add Punch
          </button>

          <button className="flex items-center gap-1.5 rounded-sm border border-[#e6dfd3] bg-[#ffffff] px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-[#63584e] hover:bg-[#f9f6f0]">
            <Printer className="h-3.5 w-3.5" />
            Print
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 2. Sidebar */}
        <aside className="w-[280px] flex-shrink-0 border-r border-[#e6dfd3] bg-[#f2ebe1] flex flex-col z-10">
          <div className="flex items-center justify-between border-b border-[#e6dfd3] p-4">
            <h2 className="text-xs font-bold tracking-widest text-[#63584e] uppercase">Drivers by Customer</h2>
            <button className="text-[#807367] hover:text-[#2b2624]">
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          
          <div className="border-b border-[#e6dfd3] p-3 bg-[#f9f6f0]">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9e9083]" />
              <input 
                type="text" 
                placeholder="Search name or KFI ID" 
                className="w-full rounded-sm border border-[#e6dfd3] bg-[#ffffff] py-1.5 pl-8 pr-3 text-sm placeholder:text-[#9e9083] focus:border-[#9a3b26] focus:outline-none focus:ring-1 focus:ring-[#9a3b26]"
              />
            </div>
            <div className="mt-3 flex">
              <button className="flex items-center gap-1.5 rounded-sm border border-[#e6dfd3] bg-[#ffffff] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#807367] hover:bg-[#f2ebe1]">
                Un-reviewed
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <CustomerGroup name="Adient" count="1">
              <DriverRow name="Jose Angulo Alfaro" hasOt reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="Schuette Metals" count="1">
              <DriverRow name="Giovanni Alexander" reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="Burnett Dairy - Grantsburg" count="3">
              <DriverRow name="Felix Baez Caballero" reviewed />
              <DriverRow name="Isidro Guerrero" reviewed />
              <DriverRow name="Willie Medina" reviewed={false} />
            </CustomerGroup>
            
            <CustomerGroup name="DeLallo" count="2">
              <DriverRow name="Cory Brittman" hasOt reviewed />
              <DriverRow name="Davidson Alcide" hasOt reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="International Wire" count="1">
              <DriverRow name="Jonathan Cedeno Mendez" reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="KFI Staffing" count="1">
              <DriverRow name="William Mejia" reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="Landscape Structures" count="3" expanded>
              <DriverRow name="Benjamin Rodriguez Gonzalez" hasOt reviewed active />
              <DriverRow name="Sebastian Villarreal" reviewed />
              <DriverRow name="Tyrek Patterson" reviewed />
            </CustomerGroup>
            
            <CustomerGroup name="Penda Corp" count="2">
            </CustomerGroup>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto pb-20">
          <div className="mx-auto max-w-6xl p-8">
            
            {/* 3. Page header band */}
            <div className="mb-8 flex items-start justify-between">
              <div>
                <h1 className="font-['Playfair_Display',serif] text-4xl font-bold tracking-tight text-[#2b2624] mb-3">
                  Benjamin Rodriguez Gonzalez
                </h1>
                <div className="flex items-center gap-3 font-mono text-xs tracking-tight text-[#63584e]">
                  <span>Customer: Landscape Structures</span>
                  <span className="h-1 w-1 rounded-full bg-[#bcaea0]"></span>
                  <span>KFI ID: 2003681</span>
                  <span className="h-1 w-1 rounded-full bg-[#bcaea0]"></span>
                  <div className="flex items-center gap-1 rounded-sm border border-[#e6dfd3] bg-[#ffffff] px-1.5 py-0.5">
                    <Globe className="h-3 w-3 text-[#9a3b26]" />
                    America/Chicago
                  </div>
                  <span className="h-1 w-1 rounded-full bg-[#bcaea0]"></span>
                  <div className="rounded-sm border border-[#e6dfd3] bg-[#ffffff] px-1.5 py-0.5 text-[#1f6063] font-semibold">
                    Landscape Structures: America/Chicago
                  </div>
                </div>
                
                <div className="mt-4 flex items-center gap-4 text-xs font-semibold uppercase tracking-wider text-[#63584e]">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#2b2624]"></span>
                    Driver (Connecteam)
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#1f6063]"></span>
                    Customer (Timesheet)
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#c66a15]"></span>
                    Overtime threshold
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button className="flex items-center justify-end gap-2 rounded-sm border border-[#d47661] bg-transparent px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[#ad422b] transition-colors hover:bg-[#f2ccc3] hover:text-[#8c3622]">
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove Connecteam time
                </button>
                <button className="flex items-center justify-end gap-2 rounded-sm border border-[#d47661] bg-transparent px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[#ad422b] transition-colors hover:bg-[#f2ccc3] hover:text-[#8c3622]">
                  <Trash2 className="h-3.5 w-3.5" />
                  Reset customer punches
                </button>
              </div>
            </div>

            {/* 4. Two-up panels */}
            <div className="mb-8 grid grid-cols-2 gap-6">
              
              {/* Summary panel */}
              <div className="flex flex-col rounded-sm border border-[#e6dfd3] bg-[#ffffff] shadow-warm">
                <div className="flex items-center justify-between border-b border-[#e6dfd3] bg-[#f2ebe1] px-5 py-3">
                  <h3 className="font-['Playfair_Display',serif] text-lg font-bold text-[#2b2624]">Summary</h3>
                  <div className="flex items-center gap-1.5 rounded-sm bg-[#fdf0e3] px-2 py-1 text-xs font-bold uppercase tracking-wider text-[#c66a15] border border-[#e59f8e]">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Differs from Connecteam (4)
                  </div>
                </div>
                <div className="flex flex-col px-5 py-4 text-sm">
                  <SummaryRow label="Total Driver" value="6.39" />
                  <SummaryRow label="Total Customer" value="40.23" />
                  <div className="my-2 h-[1px] w-full bg-[#e6dfd3]"></div>
                  <SummaryRow label="Total Hours" value="46.62" />
                  <div className="my-2 h-[1px] w-full bg-[#e6dfd3]"></div>
                  <SummaryRow label="Customer RT" value="34.23" />
                  <SummaryRow label="Customer OT" value="6.00" highlight />
                  <SummaryRow label="Driver RT" value="5.77" />
                  <SummaryRow label="Driver OT" value="0.62" highlight />
                </div>
              </div>

              {/* Checks panel */}
              <div className="flex flex-col rounded-sm border border-[#e6dfd3] bg-[#ffffff] shadow-warm">
                <div className="flex items-center gap-2 border-b border-[#e6dfd3] bg-[#e1ede8] px-5 py-3">
                  <CheckCircle2 className="h-5 w-5 text-[#2e5e4e]" />
                  <h3 className="font-['Playfair_Display',serif] text-lg font-bold text-[#2e5e4e]">Checks — all reconcile</h3>
                </div>
                <div className="flex flex-col px-5 py-4 text-sm font-mono text-[#63584e]">
                  <CheckRow label="Total = Driver + Customer" value="46.62" />
                  <CheckRow label="Customer = Total - Driver" value="40.23" />
                  <CheckRow label="Driver = Total - Customer" value="6.39" />
                  <div className="my-2 h-[1px] w-full bg-[#e6dfd3]"></div>
                  <CheckRow label="Customer RT + Driver RT = RT" value="40.00" />
                  <CheckRow label="Customer OT + Driver OT = OT" value="6.62" />
                  <CheckRow label="RT + OT = Total" value="46.62" />
                </div>
              </div>

            </div>

            {/* 5. Punches table */}
            <div className="rounded-sm border border-[#e6dfd3] bg-[#ffffff] shadow-warm overflow-hidden">
              <div className="border-b border-[#e6dfd3] bg-[#f2ebe1] px-5 py-4">
                <h3 className="font-['Playfair_Display',serif] text-xl font-bold text-[#2b2624]">Punches</h3>
              </div>
              <div className="w-full overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#e6dfd3] bg-[#fdfbf7] text-xs font-bold uppercase tracking-widest text-[#807367]">
                      <th className="px-5 py-3 font-bold">Date</th>
                      <th className="px-5 py-3 font-bold">Source</th>
                      <th className="px-5 py-3 font-bold">Clock In</th>
                      <th className="px-5 py-3 font-bold">Clock Out</th>
                      <th className="px-5 py-3 text-right font-bold">Hours</th>
                      <th className="px-5 py-3 text-right font-bold">Running</th>
                      <th className="px-5 py-3 font-bold">Type</th>
                      <th className="px-5 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e6dfd3]">
                    <PunchRow 
                      date="2026-05-11" 
                      source="DRIVER" edited 
                      clockIn="05/11, 12:32 PM" clockOut="05/11, 1:20 PM" 
                      hours="0.80" running="0.80" type="Driver" 
                    />
                    <PunchRow 
                      date="2026-05-11" 
                      source="CUSTOMER" 
                      clockIn="05/11, 1:28 PM" clockOut="05/11, 6:40 PM" 
                      hours="5.20" running="6.00" type="Customer" 
                    />
                    <PunchRow 
                      date="2026-05-11" 
                      source="CUSTOMER" 
                      clockIn="05/11, 7:10 PM" clockOut="05/12, 12:00 AM" 
                      hours="4.83" running="10.83" type="Customer" 
                    />
                    <PunchRow 
                      date="2026-05-12" 
                      source="DRIVER" edited 
                      clockIn="05/12, 12:00 AM" clockOut="05/12, 12:29 AM" 
                      hours="0.48" running="11.31" type="Driver" 
                    />
                    <PunchRow 
                      date="2026-05-12" 
                      source="DRIVER" 
                      clockIn="05/12, 12:32 PM" clockOut="05/12, 1:16 PM" 
                      hours="0.73" running="12.04" type="Driver" 
                    />
                    <PunchRow 
                      date="2026-05-12" 
                      source="CUSTOMER" 
                      clockIn="05/12, 1:26 PM" clockOut="05/12, 6:38 PM" 
                      hours="5.20" running="17.24" type="Customer" 
                    />
                    <PunchRow 
                      date="2026-05-13" 
                      source="DRIVER" 
                      clockIn="05/13, 12:01 PM" clockOut="05/13, 12:48 PM" 
                      hours="0.78" running="18.02" type="Driver" 
                    />
                    <PunchRow 
                      date="2026-05-13" 
                      source="CUSTOMER" 
                      clockIn="05/13, 12:53 PM" clockOut="05/13, 6:42 PM" 
                      hours="5.82" running="23.84" type="Customer" 
                    />
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </main>
      </div>

      {/* 6. Floating help button */}
      <button className="fixed bottom-6 right-6 flex h-12 w-12 items-center justify-center rounded-full bg-[#9a3b26] text-white shadow-lg transition-transform hover:scale-105 hover:bg-[#8c3622]">
        <LifeBuoy className="h-6 w-6" />
      </button>

    </div>
  );
}

// Subcomponents

function CustomerGroup({ name, count, expanded = false, children }: any) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between px-4 py-2 hover:bg-[#e6dfd3] cursor-pointer">
        <span className="text-xs font-bold uppercase tracking-widest text-[#63584e]">{name}</span>
        <span className="badge-rect bg-[#d8cuc0] text-[#63584e] bg-[#e6dfd3]">{count}</span>
      </div>
      {(expanded || true) && <ul className="flex flex-col">{children}</ul>}
    </div>
  );
}

function DriverRow({ name, hasOt, reviewed, active }: any) {
  return (
    <li className={`flex items-center justify-between px-4 py-2 pl-6 cursor-pointer group ${active ? 'bg-[#ffffff] border-l-2 border-[#9a3b26]' : 'hover:bg-[#f9f6f0] border-l-2 border-transparent'}`}>
      <div className="flex items-center gap-2 overflow-hidden">
        <div className={`flex-shrink-0 h-2 w-2 rounded-full ${reviewed ? 'bg-[#2e5e4e]' : 'border-2 border-[#bcaea0]'}`}></div>
        <span className={`truncate text-sm ${active ? 'font-bold text-[#2b2624]' : 'text-[#63584e] group-hover:text-[#2b2624]'}`}>{name}</span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        {hasOt && <span className="badge-rect bg-[#fdf0e3] text-[#c66a15] border border-[#e59f8e]">OT</span>}
        <button className={`opacity-0 group-hover:opacity-100 ${active ? 'opacity-100 text-[#9a3b26]' : 'text-[#9e9083]'}`}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

function SummaryRow({ label, value, highlight }: any) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="font-semibold text-[#63584e]">{label}</span>
      <span className={`font-mono text-base font-bold ${highlight ? 'text-[#c66a15]' : 'text-[#2b2624]'}`}>{value}</span>
    </div>
  );
}

function CheckRow({ label, value }: any) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2">
        <Check className="h-3 w-3 text-[#2e5e4e]" />
        <span>{label}</span>
      </div>
      <span className="text-[#2b2624] font-semibold">{value}</span>
    </div>
  );
}

function PunchRow({ date, source, edited, clockIn, clockOut, hours, running, type }: any) {
  const isDriver = type === "Driver";
  const typeColor = isDriver ? "text-[#2b2624]" : "text-[#1f6063]";
  const typeBadgeClass = isDriver ? "bg-[#2b2624] text-white" : "bg-[#1f6063] text-white";

  return (
    <tr className="table-row-hover transition-colors font-mono text-[13px] text-[#63584e]">
      <td className="px-5 py-3 whitespace-nowrap">{date}</td>
      <td className="px-5 py-3 whitespace-nowrap">
        <div className="flex flex-col items-start gap-0.5">
          <span className={`badge-rect ${typeBadgeClass}`}>{source}</span>
          {edited && <span className="text-[9px] font-bold uppercase tracking-wider text-[#9a3b26]">Edited</span>}
        </div>
      </td>
      <td className="px-5 py-3 whitespace-nowrap">{clockIn}</td>
      <td className="px-5 py-3 whitespace-nowrap">{clockOut}</td>
      <td className="px-5 py-3 text-right font-bold text-[#2b2624]">{hours}</td>
      <td className="px-5 py-3 text-right font-bold text-[#2b2624]">{running}</td>
      <td className={`px-5 py-3 font-sans font-bold tracking-wide ${typeColor}`}>{type}</td>
      <td className="px-5 py-3">
        <div className="flex items-center justify-end gap-3 text-[#9e9083]">
          <div className="h-4 w-4 rounded-sm border border-[#bcaea0] flex items-center justify-center bg-white"></div>
          <button className="hover:text-[#c66a15]"><AlertTriangle className="h-4 w-4" /></button>
          <button className="hover:text-[#9a3b26]"><MessageSquare className="h-4 w-4" /></button>
          <button className="hover:text-[#9a3b26]"><Pencil className="h-4 w-4" /></button>
          <button className="hover:text-[#ad422b]"><Trash2 className="h-4 w-4" /></button>
        </div>
      </td>
    </tr>
  );
}
