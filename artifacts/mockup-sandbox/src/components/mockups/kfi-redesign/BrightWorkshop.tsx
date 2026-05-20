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

export function BrightWorkshop() {
  return (
    <div className="min-h-screen bg-slate-100 font-['Geist'] text-slate-900 selection:bg-emerald-200">
      {/* 1. Top app bar */}
      <header className="sticky top-0 z-20 flex h-14 w-full items-center justify-between border-b border-slate-300 bg-white px-4 shadow-sm">
        <div className="flex items-center gap-4">
          <img
            src="/__mockup/images/kfi-logo-transparent.png"
            alt="KFI Staffing"
            className="h-7"
          />
          <button className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-slate-300 bg-slate-50 p-1 shadow-inner">
          <div className="flex rounded-full bg-white shadow-sm border border-slate-200 overflow-hidden">
            <button className="bg-emerald-600 px-3 py-1 text-xs font-bold text-white tracking-wide">EN</button>
            <button className="px-3 py-1 text-xs font-bold text-slate-500 hover:bg-slate-50 hover:text-slate-800 tracking-wide transition-colors">ES</button>
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 shadow-sm border border-slate-200 tracking-wide">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 stroke-[3]" />
            17 / 18 reviewed
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 shadow-sm border border-slate-200 tracking-wide">
            <Check className="h-3.5 w-3.5 text-slate-400 stroke-[3]" />
            0 / 18 punches flagged
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md shadow-sm border border-slate-300 overflow-hidden">
            <button className="flex items-center gap-1.5 bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-700 transition-colors">
              <ThumbsUp className="h-4 w-4" />
              Good
            </button>
            <button className="flex items-center gap-1.5 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors border-l border-slate-200">
              <ThumbsDown className="h-4 w-4" />
              Bad
            </button>
          </div>
          <button className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 hover:text-slate-900 transition-colors">
            <Lock className="h-4 w-4 text-slate-400" />
            Lock
          </button>
          <button className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 hover:text-slate-900 transition-colors">
            <RefreshCw className="h-4 w-4 text-emerald-600" />
            Refresh
          </button>
          <button className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 hover:shadow-none transition-all">
            <Plus className="h-4 w-4 stroke-[3]" />
            Add Punch
          </button>
          <button className="flex items-center justify-center rounded-md border border-slate-300 bg-white p-1.5 text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 transition-colors">
            <Printer className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-3.5rem)] w-full">
        {/* 2. Sidebar */}
        <aside className="w-[280px] shrink-0 border-r border-slate-300 bg-slate-50">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white p-4">
            <h2 className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Drivers by Customer</h2>
            <button className="text-slate-400 hover:text-slate-700 transition-colors">
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <div className="p-3 bg-white border-b border-slate-200">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search name or KFI ID"
                className="w-full rounded bg-slate-100 py-2 pl-9 pr-3 text-sm font-medium placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all border border-transparent focus:border-emerald-500"
              />
            </div>
            <div className="mt-3">
              <button className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-bold tracking-widest text-slate-600 hover:border-slate-400 hover:text-slate-900 transition-colors shadow-sm uppercase">
                Un-reviewed
              </button>
            </div>
          </div>

          <div className="overflow-y-auto pb-6">
            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Adient</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">1</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Jose Angulo Alfaro</span>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-black text-amber-800 uppercase tracking-widest border border-amber-200">OT</span>
                  <MoreHorizontal className="h-4 w-4 text-slate-500" />
                </div>
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Schuette Metals</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">1</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Giovanni Alexander</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Burnett Dairy - Grantsburg</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">3</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Felix Baez Caballero</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Isidro Guerrero</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Willie Medina</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">DeLallo</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">2</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Cory Brittman</span>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-black text-amber-800 uppercase tracking-widest border border-amber-200">OT</span>
                  <MoreHorizontal className="h-4 w-4 text-slate-500" />
                </div>
              </li>
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Davidson Alcide</span>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-black text-amber-800 uppercase tracking-widest border border-amber-200">OT</span>
                  <MoreHorizontal className="h-4 w-4 text-slate-500" />
                </div>
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">International Wire</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">1</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Jonathan Cedeno Mendez</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">KFI Staffing</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">1</span>
            </div>
            <ul className="mb-2">
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">William Mejia</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Landscape Structures</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">3</span>
            </div>
            <ul className="mb-2 relative">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-600"></div>
              <li className="group flex cursor-pointer items-center justify-between bg-white border-y border-slate-300 px-4 py-2 shadow-sm">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full bg-emerald-600 ring-2 ring-emerald-200"></div>
                  <span className="truncate text-[13px] font-black text-slate-900">Benjamin Rodriguez Gonzalez</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-black text-white uppercase tracking-widest">OT</span>
                  <MoreHorizontal className="h-4 w-4 text-emerald-600" />
                </div>
              </li>
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Sebastian Villarreal</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
              <li className="group flex cursor-pointer items-center justify-between px-4 py-1.5 hover:bg-slate-200/50 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 w-2 rounded-full border-2 border-slate-400"></div>
                  <span className="truncate text-[13px] font-semibold text-slate-700 group-hover:text-slate-900">Tyrek Patterson</span>
                </div>
                <MoreHorizontal className="h-4 w-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </li>
            </ul>

            <div className="mb-1 mt-4 flex items-center justify-between px-4">
              <span className="text-[11px] font-black tracking-widest text-slate-500 uppercase">Penda Corp</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 tabular-nums">2</span>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex w-full flex-col overflow-y-auto">
          {/* 3. Page header band */}
          <div className="flex flex-col gap-4 border-b border-slate-300 bg-white px-8 py-6 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-[28px] font-black tracking-tight text-slate-900">Benjamin Rodriguez Gonzalez</h1>
                <div className="mt-2.5 flex items-center gap-2.5 text-[13px] font-medium">
                  <span className="font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">Customer: Landscape Structures</span>
                  <span className="font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">KFI ID: 2003681</span>
                  <div className="flex items-center gap-1.5 rounded border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-slate-600">
                    <Globe className="h-3 w-3" />
                    America/Chicago
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-slate-600">
                    Landscape Structures: America/Chicago
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-5 text-xs font-bold tracking-wide text-slate-700 uppercase">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded bg-slate-900 shadow-sm border border-slate-700"></div>
                    Driver (Connecteam)
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded bg-emerald-500 shadow-sm border border-emerald-400"></div>
                    Customer (Timesheet)
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded bg-amber-400 shadow-sm border border-amber-300"></div>
                    Overtime threshold
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2.5">
                <button className="flex items-center gap-2 rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-red-600 shadow-sm hover:border-red-300 hover:bg-red-50 transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove Connecteam time
                </button>
                <button className="flex items-center gap-2 rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-red-600 shadow-sm hover:border-red-300 hover:bg-red-50 transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                  Reset customer punches
                </button>
              </div>
            </div>
          </div>

          <div className="p-8">
            {/* 4. Two-up panels */}
            <div className="mb-8 grid grid-cols-2 gap-8">
              {/* Summary Panel */}
              <div className="rounded border border-slate-300 bg-white shadow-sm overflow-hidden flex flex-col">
                <div className="flex items-center justify-between border-b border-slate-300 bg-slate-100 px-5 py-3">
                  <h3 className="font-black tracking-widest text-slate-800 uppercase text-xs">Summary</h3>
                  <div className="flex items-center gap-1.5 rounded bg-amber-400 px-2 py-1 text-[10px] font-black text-amber-950 uppercase tracking-widest border border-amber-500 shadow-sm">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Differs from Connecteam (4)
                  </div>
                </div>
                <div className="p-0 flex-1">
                  <table className="w-full text-[13px]">
                    <tbody className="divide-y divide-slate-200">
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-2.5 font-bold text-slate-600">Total Driver</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">6.39</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-2.5 font-bold text-slate-600">Total Customer</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">40.23</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-2.5 font-bold text-slate-600">Total Hours</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">46.62</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors bg-slate-50/50">
                        <td className="px-5 py-2.5 font-bold text-slate-600">Customer RT</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">34.23</td>
                      </tr>
                      <tr className="bg-amber-50 hover:bg-amber-100/50 transition-colors">
                        <td className="px-5 py-2.5 font-black text-amber-800">Customer OT</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-amber-800 tabular-nums">6.00</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors bg-slate-50/50">
                        <td className="px-5 py-2.5 font-bold text-slate-600">Driver RT</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">5.77</td>
                      </tr>
                      <tr className="bg-amber-50 hover:bg-amber-100/50 transition-colors border-b-0">
                        <td className="px-5 py-2.5 font-black text-amber-800">Driver OT</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-amber-800 tabular-nums">0.62</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Checks Panel */}
              <div className="rounded border border-emerald-200 bg-white shadow-sm overflow-hidden flex flex-col">
                <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-5 py-3">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 stroke-[3]" />
                  <h3 className="font-black tracking-widest text-emerald-800 uppercase text-xs">Checks — all reconcile</h3>
                </div>
                <div className="p-0 flex-1">
                  <table className="w-full text-[13px]">
                    <tbody className="divide-y divide-slate-200">
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          Total = Driver + Customer
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">46.62</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          Customer = Total - Driver
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">40.23</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          Driver = Total - Customer
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">6.39</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          Customer RT + Driver RT = RT
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">40.00</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          Customer OT + Driver OT = OT
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">6.62</td>
                      </tr>
                      <tr className="hover:bg-slate-50 transition-colors border-b-0">
                        <td className="flex items-center gap-3 px-5 py-2.5 font-mono font-medium text-slate-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3]" />
                          RT + OT = Total
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-[14px] font-black text-slate-900 tabular-nums">46.62</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* 5. Punches table */}
            <div className="rounded border border-slate-300 bg-white shadow-sm overflow-x-auto">
              <table className="w-full text-[13px] text-left border-collapse">
                <thead className="bg-slate-100 text-[11px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-300">
                  <tr>
                    <th className="px-5 py-3 border-r border-slate-200">Date</th>
                    <th className="px-5 py-3 border-r border-slate-200">Source</th>
                    <th className="px-5 py-3 border-r border-slate-200">Clock In</th>
                    <th className="px-5 py-3 border-r border-slate-200">Clock Out</th>
                    <th className="px-5 py-3 text-right border-r border-slate-200">Hours</th>
                    <th className="px-5 py-3 text-right border-r border-slate-200">Running</th>
                    <th className="px-5 py-3 border-r border-slate-200">Type</th>
                    <th className="px-5 py-3 text-right"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  
                  {/* Row 1 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-11</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <div className="flex flex-col items-start gap-1">
                        <span className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm">Driver</span>
                        <span className="text-[9px] font-black tracking-widest text-slate-500 uppercase">Edited</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/11, 12:32 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/11, 1:20 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">0.80</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">0.80</td>
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100">Driver</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 2 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-11</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm border border-emerald-600">Customer</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/11, 1:28 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/11, 6:40 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">5.20</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">6.00</td>
                    <td className="px-5 py-3 font-bold text-emerald-700 border-r border-slate-100">Customer</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 3 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-11</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm border border-emerald-600">Customer</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/11, 7:10 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 12:00 AM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">4.83</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">10.83</td>
                    <td className="px-5 py-3 font-bold text-emerald-700 border-r border-slate-100">Customer</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 4 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-12</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <div className="flex flex-col items-start gap-1">
                        <span className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm">Driver</span>
                        <span className="text-[9px] font-black tracking-widest text-slate-500 uppercase">Edited</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 12:00 AM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 12:29 AM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">0.48</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">11.31</td>
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100">Driver</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 5 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-12</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm">Driver</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 12:32 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 1:16 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">0.73</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">12.04</td>
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100">Driver</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 6 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-12</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm border border-emerald-600">Customer</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 1:26 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/12, 6:38 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">5.20</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">17.24</td>
                    <td className="px-5 py-3 font-bold text-emerald-700 border-r border-slate-100">Customer</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 7 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-13</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-slate-900 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm">Driver</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/13, 12:01 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/13, 12:48 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">0.78</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">18.02</td>
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100">Driver</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                  {/* Row 8 */}
                  <tr className="group even:bg-slate-50 hover:bg-emerald-50/50 transition-colors">
                    <td className="px-5 py-3 font-bold text-slate-900 border-r border-slate-100 whitespace-nowrap">2026-05-13</td>
                    <td className="px-5 py-3 border-r border-slate-100">
                      <span className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-black tracking-widest text-white uppercase shadow-sm border border-emerald-600">Customer</span>
                    </td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/13, 12:53 PM</td>
                    <td className="px-5 py-3 font-mono font-medium text-slate-700 border-r border-slate-100 whitespace-nowrap">05/13, 6:42 PM</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">5.82</td>
                    <td className="px-5 py-3 text-right font-mono font-black text-slate-900 border-r border-slate-100 tabular-nums">23.84</td>
                    <td className="px-5 py-3 font-bold text-emerald-700 border-r border-slate-100">Customer</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Check className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 shadow-sm"><AlertTriangle className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><MessageSquare className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-700 shadow-sm"><Pencil className="h-4 w-4 stroke-[2.5]" /></button>
                        <button className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-red-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 shadow-sm"><Trash2 className="h-4 w-4 stroke-[2.5]" /></button>
                      </div>
                    </td>
                  </tr>

                </tbody>
              </table>
            </div>
            
            {/* End content padding */}
            <div className="h-24"></div>
          </div>
        </main>
      </div>

      {/* 6. Floating help button */}
      <button className="fixed bottom-8 right-8 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-600/30 transition-all hover:-translate-y-1 hover:bg-emerald-700 hover:shadow-[0_12px_40px_rgb(0,0,0,0.16)] hover:shadow-emerald-600/40">
        <LifeBuoy className="h-6 w-6 stroke-[2.5]" />
      </button>
    </div>
  );
}
