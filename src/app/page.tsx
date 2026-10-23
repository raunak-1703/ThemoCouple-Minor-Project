"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import {
  Usb,
  Thermometer,
  Zap,
  Activity,
  CircleDot,
  Clock,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Unplug,
} from "lucide-react";

// ─── Type definitions ───────────────────────────────────────────────────────────

interface SensorData {
  time: number;
  voltage: number;
  temp: number;
}

interface DataPoint extends SensorData {
  displayTime: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const BAUD_RATE = 115200;
const MAX_DATA_POINTS = 100;

// ─── Custom Recharts Tooltip ────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="glass-panel rounded-lg px-4 py-3 shadow-xl">
      <p className="mb-2 text-xs font-medium text-zinc-400">{label}</p>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <div
            className="h-2 w-2 rounded-full"
            style={{ background: entry.color }}
          />
          <span className="text-xs text-zinc-300">
            {entry.name === "temp"
              ? `Temperature: ${entry.value.toFixed(2)} °C`
              : `Voltage: ${(entry.value * 1000).toFixed(1)} mV`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page Component ────────────────────────────────────────────────────────

export default function DashboardPage() {
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Serial port refs (persist across renders)
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Data state
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [latestData, setLatestData] = useState<SensorData | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  // Stats
  const [minTemp, setMinTemp] = useState<number>(Infinity);
  const [maxTemp, setMaxTemp] = useState<number>(-Infinity);

  // ─── Connect to ESP32 via Web Serial API ──────────────────────────────────

  const connectToESP32 = useCallback(async () => {
    try {
      setIsConnecting(true);
      setError(null);

      // Check browser support
      if (!("serial" in navigator)) {
        throw new Error(
          "Web Serial API is not supported in this browser. Please use Chrome or Edge."
        );
      }

      // Request port
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD_RATE });

      portRef.current = port;
      setIsConnected(true);
      setStartTime(Date.now());
      setSampleCount(0);
      setMinTemp(Infinity);
      setMaxTemp(-Infinity);
      setDataPoints([]);

      // Create abort controller for clean disconnect
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Set up readable stream with TextDecoderStream
      const textDecoder = new TextDecoderStream();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readableStreamClosed = port.readable!.pipeTo(textDecoder.writable as WritableStream<Uint8Array>, {
        signal: abortController.signal,
      });

      const reader = textDecoder.readable.getReader();
      readerRef.current = reader;

      // Read loop — accumulate chunks and parse JSON lines
      let buffer = "";

      const readLoop = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += value;

            // Split on newline — ESP32 sends \n-terminated JSON
            const lines = buffer.split("\n");
            // Keep the last (possibly incomplete) chunk in the buffer
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const parsed: SensorData = JSON.parse(trimmed);

                // Validate parsed data
                if (
                  typeof parsed.time !== "number" ||
                  typeof parsed.voltage !== "number" ||
                  typeof parsed.temp !== "number"
                ) {
                  continue;
                }

                const displayTime = (parsed.time / 1000).toFixed(1) + "s";

                const point: DataPoint = { ...parsed, displayTime };

                setLatestData(parsed);
                setSampleCount((prev) => prev + 1);
                setMinTemp((prev) => Math.min(prev, parsed.temp));
                setMaxTemp((prev) => Math.max(prev, parsed.temp));

                setDataPoints((prev) => {
                  const next = [...prev, point];
                  // Keep only the last MAX_DATA_POINTS
                  if (next.length > MAX_DATA_POINTS) {
                    return next.slice(next.length - MAX_DATA_POINTS);
                  }
                  return next;
                });
              } catch {
                // Ignore malformed JSON lines
              }
            }
          }
        } catch (err) {
          // ReadableStream cancel or abort — expected on disconnect
          if (
            err instanceof Error &&
            err.name !== "AbortError" &&
            !err.message.includes("aborted")
          ) {
            console.error("Read error:", err);
          }
        }
      };

      readLoop();

      // Wait for the piped stream to close (fires on disconnect/abort)
      readableStreamClosed.catch(() => {});
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect to ESP32";
      setError(message);
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // ─── Disconnect ───────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    try {
      // Abort the piped stream
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      // Release the reader
      if (readerRef.current) {
        try {
          readerRef.current.releaseLock();
        } catch {}
        readerRef.current = null;
      }

      // Close the port
      if (portRef.current) {
        try {
          await portRef.current.close();
        } catch {}
        portRef.current = null;
      }

      setIsConnected(false);
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, []);

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // ─── Derived values ───────────────────────────────────────────────────────

  const elapsed = startTime
    ? Math.floor((Date.now() - startTime) / 1000)
    : 0;

  // Dynamic Y-axis domain for temperature
  const tempValues = dataPoints.map((d) => d.temp);
  const yMin =
    tempValues.length > 0
      ? Math.floor(Math.min(...tempValues) - 2)
      : 20;
  const yMax =
    tempValues.length > 0
      ? Math.ceil(Math.max(...tempValues) + 2)
      : 150;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="grid-bg flex min-h-screen flex-col">
      {/* ── Navigation Bar ── */}
      <header className="glass-panel sticky top-0 z-50 border-b border-white/[0.06]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          {/* Logo & Title */}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20">
              <Activity className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-100">
                ThermoDAQ
              </h1>
              <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                Precision Monitor
              </p>
            </div>
          </div>

          {/* Status + Connect Button */}
          <div className="flex items-center gap-4">
            {/* Live indicator */}
            {isConnected && (
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs"
                >
                  LIVE
                </Badge>
              </div>
            )}

            {/* Connect / Disconnect Button */}
            {isConnected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={disconnect}
                className="gap-2 border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300"
              >
                <Unplug className="h-4 w-4" />
                Disconnect
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={connectToESP32}
                disabled={isConnecting}
                className="gap-2 border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-300"
              >
                <Usb className="h-4 w-4" />
                {isConnecting
                  ? "Connecting..."
                  : "Connect to ESP32 (USB)"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-6 py-8">
        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 text-sm text-red-400">
            <CircleDot className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Stat Cards Row ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Voltage Card */}
          <Card className="glass-panel glow-amber border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-amber-400/80 uppercase">
                  <Zap className="h-3.5 w-3.5" />
                  Voltage
                </CardDescription>
                <Badge
                  variant="outline"
                  className="border-amber-500/20 bg-amber-500/5 text-amber-400 text-[10px]"
                >
                  LIVE
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-3xl font-bold tracking-tight text-amber-300">
                  {latestData
                    ? (latestData.voltage * 1000).toFixed(1)
                    : "---.-"}
                </span>
                <span className="text-sm font-medium text-amber-400/60">
                  mV
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Raw:{" "}
                {latestData
                  ? latestData.voltage.toFixed(4) + " V"
                  : "No data"}
              </p>
            </CardContent>
          </Card>

          {/* Temperature Card */}
          <Card className="glass-panel glow-cyan border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-cyan-400/80 uppercase">
                  <Thermometer className="h-3.5 w-3.5" />
                  Temperature
                </CardDescription>
                <Badge
                  variant="outline"
                  className="border-cyan-500/20 bg-cyan-500/5 text-cyan-400 text-[10px]"
                >
                  LIVE
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-3xl font-bold tracking-tight text-cyan-300">
                  {latestData ? latestData.temp.toFixed(2) : "---:--"}
                </span>
                <span className="text-sm font-medium text-cyan-400/60">
                  °C
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Range:{" "}
                {minTemp !== Infinity
                  ? `${minTemp.toFixed(1)}°C — ${maxTemp.toFixed(1)}°C`
                  : "No data"}
              </p>
            </CardContent>
          </Card>

          {/* Sample Count Card */}
          <Card className="glass-panel glow-emerald border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-emerald-400/80 uppercase">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Samples
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-3xl font-bold tracking-tight text-emerald-300">
                  {sampleCount.toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Rate:{" "}
                {sampleCount > 0 && elapsed > 0
                  ? `~${(sampleCount / elapsed).toFixed(0)} sps`
                  : "—"}
              </p>
            </CardContent>
          </Card>

          {/* Temp Trend Card */}
          <Card className="glass-panel border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">
                  <Clock className="h-3.5 w-3.5" />
                  Session
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-3xl font-bold tracking-tight text-zinc-200">
                  {isConnected
                    ? formatElapsedTime(elapsed)
                    : "00:00"}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                {dataPoints.length >= 2 ? (
                  dataPoints[dataPoints.length - 1].temp >
                  dataPoints[dataPoints.length - 2].temp ? (
                    <>
                      <TrendingUp className="h-3 w-3 text-red-400" />
                      <span className="text-red-400">Rising</span>
                    </>
                  ) : (
                    <>
                      <TrendingDown className="h-3 w-3 text-blue-400" />
                      <span className="text-blue-400">Falling</span>
                    </>
                  )
                ) : (
                  <span>Awaiting data</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Temperature Chart ── */}
        <Card className="glass-panel border-0">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-zinc-100">
                  <Thermometer className="h-4 w-4 text-cyan-400" />
                  Temperature Timeline
                </CardTitle>
                <CardDescription className="mt-1 text-xs text-zinc-500">
                  Real-time temperature readings — last{" "}
                  {MAX_DATA_POINTS} data points at ~50 ms intervals
                </CardDescription>
              </div>
              <Badge
                variant="outline"
                className="border-zinc-700 text-zinc-400 text-xs"
              >
                {dataPoints.length} / {MAX_DATA_POINTS} pts
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[400px] w-full">
              {dataPoints.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-600">
                  <Activity className="h-12 w-12 animate-pulse" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-zinc-400">
                      No data to display
                    </p>
                    <p className="mt-1 text-xs text-zinc-600">
                      Connect to the ESP32 to begin streaming temperature
                      data
                    </p>
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={dataPoints}
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="tempGradient"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="#22d3ee"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="100%"
                          stopColor="#22d3ee"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(255,255,255,0.04)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="displayTime"
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      interval="preserveStartEnd"
                      minTickGap={50}
                    />
                    <YAxis
                      domain={[yMin, yMax]}
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      tickFormatter={(v: number) => `${v}°`}
                      width={50}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
                      cursor={{
                        stroke: "rgba(34, 211, 238, 0.2)",
                        strokeWidth: 1,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="temp"
                      stroke="#22d3ee"
                      strokeWidth={2}
                      fill="url(#tempGradient)"
                      dot={false}
                      activeDot={{
                        r: 4,
                        fill: "#22d3ee",
                        stroke: "#0a0b0f",
                        strokeWidth: 2,
                      }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Voltage Chart ── */}
        <Card className="glass-panel border-0">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base text-zinc-100">
                  <Zap className="h-4 w-4 text-amber-400" />
                  Voltage Timeline
                </CardTitle>
                <CardDescription className="mt-1 text-xs text-zinc-500">
                  Raw ADC voltage output from thermocouple amplifier
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[250px] w-full">
              {dataPoints.length === 0 ? (
                <div className="flex h-full items-center justify-center text-zinc-600">
                  <p className="text-sm text-zinc-500">
                    Awaiting serial data...
                  </p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={dataPoints}
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="voltGradient"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="#fbbf24"
                          stopOpacity={0.25}
                        />
                        <stop
                          offset="100%"
                          stopColor="#fbbf24"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(255,255,255,0.04)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="displayTime"
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      interval="preserveStartEnd"
                      minTickGap={50}
                    />
                    <YAxis
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      tickFormatter={(v: number) =>
                        `${(v * 1000).toFixed(0)}`
                      }
                      width={50}
                      label={{
                        value: "mV",
                        angle: -90,
                        position: "insideLeft",
                        fill: "#71717a",
                        fontSize: 11,
                        offset: 10,
                      }}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
                      cursor={{
                        stroke: "rgba(251, 191, 36, 0.2)",
                        strokeWidth: 1,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="voltage"
                      stroke="#fbbf24"
                      strokeWidth={2}
                      fill="url(#voltGradient)"
                      dot={false}
                      activeDot={{
                        r: 4,
                        fill: "#fbbf24",
                        stroke: "#0a0b0f",
                        strokeWidth: 2,
                      }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.04] py-5">
        <div className="mx-auto max-w-7xl px-6 text-center text-xs text-zinc-600">
          ThermoDAQ v1.0 — Web Serial API ·{" "}
          {BAUD_RATE.toLocaleString()} baud · ESP32 USB Bridge
        </div>
      </footer>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsedTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
