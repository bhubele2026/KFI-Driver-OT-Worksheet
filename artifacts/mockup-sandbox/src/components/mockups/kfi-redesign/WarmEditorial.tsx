import React, { useState } from "react";
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

export function WarmEditorial() {
  return (
    <div
      className="min-h-screen w-full flex flex-col font-['DM_Sans',sans-serif] selection:bg-[#bb5637] selection:text-[#f7f4ea]"
      style={{
        backgroundColor: "#f7f4ea",
        color: "#272422",
      }}
    >
      {/* 1. Top App Bar */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-6 py-3 border-b"
        style={{
          backgroundColor: "#fcfbf8",
          borderColor: "#e8e2d4",
        }}
      >
        {/* Left Cluster */}
        <div className="flex items-center gap-6">
          <img
            src="/__mockup/images/kfi-logo-transparent.png"
            alt="KFI Staffing"
            className="h-8 object-contain"
            style={{ filter: "opacity(0.85) sepia(1) hue-rotate(-50deg) saturate(20deg) contrast(1.5)" }} 
          />
          <button
            className="flex items-center gap-2 text-sm transition-colors"
            style={{ color: "#635b57" }}
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="font-medium tracking-wide uppercase text-xs">Back</span>
          </button>
        </div>

        {/* Center Cluster */}
        <div className="flex items-center gap-4">
          <div
            className="flex items-center rounded-full p-0.5 border"
            style={{ borderColor: "#e8e2d4", backgroundColor: "#f7f4ea" }}
          >
            <button
              className="px-3 py-1 text-xs font-semibold rounded-full shadow-sm"
              style={{ backgroundColor: "#fcfbf8", color: "#272422" }}
            >
              EN
            </button>
            <button
              className="px-3 py-1 text-xs font-medium rounded-full"
              style={{ color: "#635b57" }}
            >
              ES
            </button>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border"
            style={{
              borderColor: "#e8e2d4",
              backgroundColor: "#fcfbf8",
              color: "#567a4e",
            }}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-xs font-medium tracking-wide uppercase">17 / 18 reviewed</span>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border"
            style={{
              borderColor: "#e8e2d4",
              backgroundColor: "#fcfbf8",
              color: "#272422",
            }}
          >
            <Check className="w-4 h-4" />
            <span className="text-xs font-medium tracking-wide uppercase">0 / 18 punches</span>
          </div>
        </div>

        {/* Right Cluster */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center rounded-full p-0.5 border"
            style={{ borderColor: "#e8e2d4", backgroundColor: "#f7f4ea" }}
          >
            <button
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full shadow-sm"
              style={{ backgroundColor: "#fcfbf8", color: "#272422" }}
            >
              <ThumbsUp className="w-3.5 h-3.5" /> Good
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full"
              style={{ color: "#635b57" }}
            >
              <ThumbsDown className="w-3.5 h-3.5" /> Bad
            </button>
          </div>

          <button
            className="p-2 rounded-full hover:bg-black/5 transition-colors"
            style={{ color: "#635b57" }}
            title="Lock"
          >
            <Lock className="w-4 h-4" />
          </button>
          <button
            className="p-2 rounded-full hover:bg-black/5 transition-colors"
            style={{ color: "#635b57" }}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            className="flex items-center gap-2 px-4 py-1.5 rounded-full shadow-sm text-sm font-medium transition-colors"
            style={{
              backgroundColor: "#bb5637",
              color: "#fcfbf8",
            }}
          >
            <Plus className="w-4 h-4" />
            Add Punch
          </button>

          <button
            className="p-2 rounded-full hover:bg-black/5 transition-colors"
            style={{ color: "#635b57" }}
            title="Print"
          >
            <Printer className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 2. Sidebar */}
        <aside
          className="w-[280px] shrink-0 border-r flex flex-col overflow-y-auto"
          style={{
            backgroundColor: "#fcfbf8",
            borderColor: "#e8e2d4",
          }}
        >
          <div className="p-4 border-b" style={{ borderColor: "#e8e2d4" }}>
            <div className="flex items-center justify-between mb-4">
              <h2
                className="text-xs font-bold tracking-widest uppercase"
                style={{ color: "#635b57" }}
              >
                Drivers by Customer
              </h2>
              <button className="p-1 rounded hover:bg-black/5 text-[#635b57]">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <div className="relative mb-4">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#635b57]" />
              <input
                type="text"
                placeholder="Search name or KFI ID"
                className="w-full pl-9 pr-3 py-2 text-sm rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-[#bb5637]"
                style={{
                  borderColor: "#e8e2d4",
                  color: "#272422",
                }}
              />
            </div>
            <button
              className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border transition-colors"
              style={{
                borderColor: "#e8e2d4",
                backgroundColor: "#f7f4ea",
                color: "#635b57",
              }}
            >
              UN-REVIEWED
            </button>
          </div>

          <div className="p-2">
            {[
              {
                customer: "ADIENT",
                count: 1,
                drivers: [{ name: "Jose Angulo Alfaro", ot: true, reviewed: false }],
              },
              {
                customer: "SCHUETTE METALS",
                count: 1,
                drivers: [{ name: "Giovanni Alexander", ot: false, reviewed: false }],
              },
              {
                customer: "BURNETT DAIRY - GRANTSBURG",
                count: 3,
                drivers: [
                  { name: "Felix Baez Caballero", ot: false, reviewed: false },
                  { name: "Isidro Guerrero", ot: false, reviewed: false },
                  { name: "Willie Medina", ot: false, reviewed: false },
                ],
              },
              {
                customer: "DELALLO",
                count: 2,
                drivers: [
                  { name: "Cory Brittman", ot: true, reviewed: false },
                  { name: "Davidson Alcide", ot: true, reviewed: false },
                ],
              },
              {
                customer: "INTERNATIONAL WIRE",
                count: 1,
                drivers: [{ name: "Jonathan Cedeno Mendez", ot: false, reviewed: false }],
              },
              {
                customer: "KFI STAFFING",
                count: 1,
                drivers: [{ name: "William Mejia", ot: false, reviewed: false }],
              },
              {
                customer: "LANDSCAPE STRUCTURES",
                count: 3,
                drivers: [
                  { name: "Benjamin Rodriguez Gonzalez", ot: true, reviewed: true, active: true },
                  { name: "Sebastian Villarreal", ot: false, reviewed: false },
                  { name: "Tyrek Patterson", ot: false, reviewed: false },
                ],
              },
              {
                customer: "PENDA CORP",
                count: 2,
                drivers: [],
              },
            ].map((group, idx) => (
              <div key={idx} className="mb-1">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span
                    className="text-[10px] font-bold tracking-widest uppercase"
                    style={{ color: "#635b57" }}
                  >
                    {group.customer}
                  </span>
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#f7f4ea] text-[#635b57]"
                  >
                    {group.count}
                  </span>
                </div>
                <div>
                  {group.drivers.map((d, dIdx) => (
                    <div
                      key={dIdx}
                      className={`group flex items-center justify-between px-2 py-1.5 rounded cursor-pointer ${
                        d.active ? "bg-[#f7f4ea]" : "hover:bg-[#f7f4ea]/50"
                      }`}
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            d.reviewed ? "bg-[#567a4e]" : "border border-[#635b57]"
                          }`}
                        />
                        <span
                          className={`text-sm truncate ${
                            d.active ? "font-bold text-[#272422]" : "font-medium text-[#635b57]"
                          }`}
                        >
                          {d.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        {d.ot && (
                          <span
                            className="text-[9px] font-bold tracking-wider uppercase px-1.5 rounded border"
                            style={{
                              borderColor: "#cc7929",
                              color: "#cc7929",
                            }}
                          >
                            OT
                          </span>
                        )}
                        <MoreHorizontal className="w-3.5 h-3.5 text-[#635b57] opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col overflow-y-auto">
          <div className="max-w-6xl mx-auto w-full p-8 flex flex-col gap-8 pb-24">
            
            {/* 3. Page Header Band */}
            <div className="flex items-start justify-between">
              <div>
                <h1
                  className="text-4xl font-['Lora',serif] font-medium tracking-tight mb-3"
                  style={{ color: "#272422" }}
                >
                  Benjamin Rodriguez Gonzalez
                </h1>
                
                <div
                  className="flex items-center flex-wrap gap-2 text-sm font-['IBM_Plex_Mono',monospace]"
                  style={{ color: "#635b57" }}
                >
                  <span>Customer: Landscape Structures</span>
                  <span className="opacity-50">•</span>
                  <span>KFI ID: 2003681</span>
                  <span className="opacity-50">•</span>
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded border" style={{ borderColor: "#e8e2d4", backgroundColor: "#fcfbf8" }}>
                    <Globe className="w-3.5 h-3.5" />
                    <span className="text-xs font-medium">America/Chicago</span>
                  </div>
                  <div className="px-2 py-0.5 rounded border" style={{ borderColor: "#e8e2d4", backgroundColor: "#fcfbf8" }}>
                    <span className="text-xs font-medium">Landscape Structures: America/Chicago</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-4 text-xs font-medium uppercase tracking-wide">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#272422" }} />
                    <span style={{ color: "#635b57" }}>Driver (Connecteam)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#34756d" }} />
                    <span style={{ color: "#635b57" }}>Customer (Timesheet)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#cc7929" }} />
                    <span style={{ color: "#635b57" }}>Overtime threshold</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 items-end">
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded border border-[#bb5637]/30 text-[#bb5637] hover:bg-[#bb5637]/5 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove Connecteam time
                </button>
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded border border-[#bb5637]/30 text-[#bb5637] hover:bg-[#bb5637]/5 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Reset customer punches
                </button>
              </div>
            </div>

            {/* 4. Two-up panels: Summary + Checks */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Summary Panel */}
              <div
                className="rounded-lg shadow-sm border"
                style={{
                  backgroundColor: "#fcfbf8",
                  borderColor: "#e8e2d4",
                }}
              >
                <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#e8e2d4" }}>
                  <h3 className="font-['Lora',serif] text-lg font-medium">Summary</h3>
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold tracking-wide uppercase"
                    style={{
                      borderColor: "#cc7929",
                      backgroundColor: "#fffdfa",
                      color: "#cc7929",
                    }}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    DIFFERS FROM CONNECTEAM (4)
                  </div>
                </div>
                <div className="p-5">
                  <div className="space-y-1">
                    {[
                      { label: "Total Driver", value: "6.39", bold: true },
                      { label: "Total Customer", value: "40.23", bold: true },
                      { label: "Total Hours", value: "46.62", bold: true },
                      { label: "Customer RT", value: "34.23", bold: false },
                      { label: "Customer OT", value: "6.00", bold: true, amber: true },
                      { label: "Driver RT", value: "5.77", bold: false },
                      { label: "Driver OT", value: "0.62", bold: true, amber: true },
                    ].map((row, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-transparent hover:border-[#e8e2d4]/50">
                        <span className="text-sm text-[#635b57] font-medium">{row.label}</span>
                        <span
                          className={`font-['IBM_Plex_Mono',monospace] text-sm ${row.bold ? 'font-bold' : 'font-medium'} ${row.amber ? 'text-[#cc7929]' : 'text-[#272422]'}`}
                        >
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Checks Panel */}
              <div
                className="rounded-lg shadow-sm border"
                style={{
                  backgroundColor: "#fcfbf8",
                  borderColor: "#e8e2d4",
                }}
              >
                <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: "#e8e2d4" }}>
                  <CheckCircle2 className="w-5 h-5 text-[#567a4e]" />
                  <h3 className="font-['Lora',serif] text-lg font-medium text-[#567a4e]">
                    Checks — all reconcile
                  </h3>
                </div>
                <div className="p-5">
                  <div className="space-y-1">
                    {[
                      { label: "Total = Driver + Customer", value: "46.62" },
                      { label: "Customer = Total - Driver", value: "40.23" },
                      { label: "Driver = Total - Customer", value: "6.39" },
                      { label: "Customer RT + Driver RT = RT", value: "40.00" },
                      { label: "Customer OT + Driver OT = OT", value: "6.62" },
                      { label: "RT + OT = Total", value: "46.62" },
                    ].map((row, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-transparent hover:border-[#e8e2d4]/50">
                        <div className="flex items-center gap-2">
                          <Check className="w-3.5 h-3.5 text-[#567a4e]" />
                          <span className="font-['IBM_Plex_Mono',monospace] text-xs text-[#635b57]">{row.label}</span>
                        </div>
                        <span className="font-['IBM_Plex_Mono',monospace] text-sm font-medium text-[#272422]">
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* 5. Punches table */}
            <div className="mt-4 border-t border-[#e8e2d4] pt-6">
              <table className="w-full text-left text-sm whitespace-nowrap border-collapse">
                <thead>
                  <tr className="border-b border-[#e8e2d4] text-[10px] uppercase tracking-widest text-[#635b57] font-bold">
                    <th className="pb-3 px-2 font-bold">Date</th>
                    <th className="pb-3 px-2 font-bold">Source</th>
                    <th className="pb-3 px-2 font-bold text-right">Clock in</th>
                    <th className="pb-3 px-2 font-bold text-right">Clock out</th>
                    <th className="pb-3 px-2 font-bold text-right">Hours</th>
                    <th className="pb-3 px-2 font-bold text-right">Running</th>
                    <th className="pb-3 px-2 font-bold">Type</th>
                    <th className="pb-3 px-2 font-bold text-right"></th>
                  </tr>
                </thead>
                <tbody className="font-['IBM_Plex_Mono',monospace]">
                  {[
                    { date: "2026-05-11", source: "DRIVER", edited: true, in: "05/11, 12:32 PM", out: "05/11, 1:20 PM", hrs: "0.80", run: "0.80", type: "Driver" },
                    { date: "2026-05-11", source: "CUSTOMER", edited: false, in: "05/11, 1:28 PM", out: "05/11, 6:40 PM", hrs: "5.20", run: "6.00", type: "Customer" },
                    { date: "2026-05-11", source: "CUSTOMER", edited: false, in: "05/11, 7:10 PM", out: "05/12, 12:00 AM", hrs: "4.83", run: "10.83", type: "Customer" },
                    { date: "2026-05-12", source: "DRIVER", edited: true, in: "05/12, 12:00 AM", out: "05/12, 12:29 AM", hrs: "0.48", run: "11.31", type: "Driver" },
                    { date: "2026-05-12", source: "DRIVER", edited: false, in: "05/12, 12:32 PM", out: "05/12, 1:16 PM", hrs: "0.73", run: "12.04", type: "Driver" },
                    { date: "2026-05-12", source: "CUSTOMER", edited: false, in: "05/12, 1:26 PM", out: "05/12, 6:38 PM", hrs: "5.20", run: "17.24", type: "Customer" },
                    { date: "2026-05-13", source: "DRIVER", edited: false, in: "05/13, 12:01 PM", out: "05/13, 12:48 PM", hrs: "0.78", run: "18.02", type: "Driver" },
                    { date: "2026-05-13", source: "CUSTOMER", edited: false, in: "05/13, 12:53 PM", out: "05/13, 6:42 PM", hrs: "5.82", run: "23.84", type: "Customer" },
                  ].map((row, i) => {
                    const isDriver = row.source === "DRIVER";
                    return (
                      <tr key={i} className="border-b border-[#e8e2d4]/40 hover:bg-[#fcfbf8] transition-colors">
                        <td className="py-3 px-2 text-[#635b57] font-medium">{row.date}</td>
                        <td className="py-3 px-2">
                          <div className="flex flex-col items-start font-sans">
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wide uppercase text-white shadow-inner"
                              style={{ backgroundColor: isDriver ? "#272422" : "#34756d" }}
                            >
                              {row.source}
                            </span>
                            {row.edited && (
                              <span className="text-[9px] font-bold text-[#bb5637] mt-1 ml-1 tracking-widest uppercase">
                                EDITED
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-2 text-right text-[#272422]">{row.in}</td>
                        <td className="py-3 px-2 text-right text-[#272422]">{row.out}</td>
                        <td className="py-3 px-2 text-right font-medium text-[#272422]">{row.hrs}</td>
                        <td className="py-3 px-2 text-right font-bold text-[#635b57]">{row.run}</td>
                        <td className="py-3 px-2 font-sans font-medium text-sm">
                          <span style={{ color: isDriver ? "#272422" : "#34756d" }}>{row.type}</span>
                        </td>
                        <td className="py-3 px-2">
                          <div className="flex items-center justify-end gap-3 text-[#635b57]">
                            <div className="w-4 h-4 rounded border border-[#635b57] shrink-0" />
                            <AlertTriangle className="w-4 h-4 hover:text-[#cc7929] cursor-pointer" />
                            <MessageSquare className="w-4 h-4 hover:text-[#272422] cursor-pointer" />
                            <Pencil className="w-4 h-4 hover:text-[#272422] cursor-pointer" />
                            <Trash2 className="w-4 h-4 hover:text-[#bb5637] cursor-pointer" />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          </div>
        </main>
      </div>

      {/* 6. Floating help button */}
      <button
        className="fixed bottom-8 right-8 w-12 h-12 rounded-full shadow flex items-center justify-center transition-transform hover:scale-105"
        style={{
          backgroundColor: "#bb5637",
          color: "#fcfbf8",
        }}
      >
        <LifeBuoy className="w-6 h-6" />
      </button>

    </div>
  );
}
