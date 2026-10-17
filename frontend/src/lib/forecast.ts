import type { RecurringSchedule } from "../types/accord";

export type ProjectedOutflowPoint = {
  month: string;
  label: string;
  timestamp: number;
  outflow: number;
  cumulativeOutflow: number;
  activeSchedulesCount: number;
};

export type RunwayEstimate = {
  runwayMonths: number | null;
  label: string;
  isDepleted: boolean;
};

export type ForecastSummary = {
  points: ProjectedOutflowPoint[];
  totalProjectedOutflow: number;
  averageMonthlyOutflow: number;
  runway: RunwayEstimate;
};

export function computeProjectedOutflowSeries(
  schedules: RecurringSchedule[],
  options: {
    months?: number;
    startDate?: Date;
  } = {},
): ProjectedOutflowPoint[] {
  const monthsCount = Math.max(1, options.months ?? 6);
  const now = options.startDate ?? new Date();

  // Create monthly time windows
  const windows: { start: number; end: number; monthKey: string; label: string }[] = [];
  for (let i = 0; i < monthsCount; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() + i, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + i + 1, 0, 23, 59, 59, 999);
    const monthKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
    const label = start.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    windows.push({ start: start.getTime(), end: end.getTime(), monthKey, label });
  }

  const horizonEnd = windows[windows.length - 1].end;

  // Filter active schedules and initialize simulation state
  const activeSchedules = schedules.filter((s) => s.status === "active");

  const scheduleSimStates = activeSchedules.map((s) => {
    const amount = Number.parseFloat(s.amount);
    const intervalSecs = s.interval ?? 0;
    const intervalMs = Math.max(1, intervalSecs * 1000);

    const capNum = s.cap !== undefined ? Number.parseFloat(s.cap) : Infinity;
    const disbursedNum = s.totalDisbursed ? Number.parseFloat(s.totalDisbursed) : 0;
    const remainingCap = Number.isFinite(capNum) ? Math.max(0, capNum - disbursedNum) : Infinity;

    const endDateTs =
      s.endDate !== undefined
        ? Number(s.endDate) > 1e11
          ? Number(s.endDate)
          : Number(s.endDate) * 1000
        : undefined;

    const cliffTs =
      s.cliff !== undefined
        ? Number(s.cliff) > 1e11
          ? Number(s.cliff)
          : Number(s.cliff) * 1000
        : undefined;

    const nextDisbursementTs = s.nextDisbursementTs ?? now.getTime();

    return {
      id: s.id,
      amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
      intervalMs,
      remainingCap,
      endDateTs,
      cliffTs,
      currentNextTs: nextDisbursementTs,
      valid: Number.isFinite(amount) && amount > 0 && intervalSecs > 0,
    };
  });

  const points: ProjectedOutflowPoint[] = [];
  let cumulativeOutflow = 0;

  for (const window of windows) {
    let windowOutflow = 0;
    let activeInWindow = 0;

    for (const sim of scheduleSimStates) {
      if (!sim.valid) continue;
      if (sim.remainingCap <= 0) continue;
      if (sim.endDateTs !== undefined && window.start > sim.endDateTs) continue;

      let scheduleContributedInWindow = false;

      // Disburse all occurrences that land within or before this window end
      while (sim.currentNextTs <= window.end && sim.currentNextTs <= horizonEnd) {
        if (sim.currentNextTs >= window.start) {
          if (sim.cliffTs === undefined || sim.currentNextTs >= sim.cliffTs) {
            if (sim.endDateTs === undefined || sim.currentNextTs <= sim.endDateTs) {
              if (sim.remainingCap > 0) {
                const payout = Math.min(sim.amount, sim.remainingCap);
                windowOutflow += payout;
                sim.remainingCap -= payout;
                scheduleContributedInWindow = true;
              }
            }
          }
        }

        // Advance to next disbursement
        sim.currentNextTs += sim.intervalMs;

        // If cap reached, stop processing this schedule
        if (sim.remainingCap <= 0) break;
      }

      if (scheduleContributedInWindow || (sim.remainingCap > 0 && (sim.endDateTs === undefined || window.end <= sim.endDateTs))) {
        activeInWindow++;
      }
    }

    cumulativeOutflow += windowOutflow;

    points.push({
      month: window.monthKey,
      label: window.label,
      timestamp: window.start,
      outflow: Math.round(windowOutflow * 100) / 100,
      cumulativeOutflow: Math.round(cumulativeOutflow * 100) / 100,
      activeSchedulesCount: activeInWindow,
    });
  }

  return points;
}

export function computeRunway(
  currentBalance: number,
  averageMonthlyOutflow: number,
  points: ProjectedOutflowPoint[] = [],
): RunwayEstimate {
  if (!Number.isFinite(currentBalance) || currentBalance <= 0) {
    return {
      runwayMonths: 0,
      label: "0 months (depleted)",
      isDepleted: true,
    };
  }

  if (!Number.isFinite(averageMonthlyOutflow) || averageMonthlyOutflow <= 0) {
    return {
      runwayMonths: null,
      label: "Runway: ∞ (No recurring outflow)",
      isDepleted: false,
    };
  }

  // Check if balance runs out during projected points
  for (let i = 0; i < points.length; i++) {
    if (points[i].cumulativeOutflow >= currentBalance) {
      const prevCumulative = i > 0 ? points[i - 1].cumulativeOutflow : 0;
      const neededInMonth = currentBalance - prevCumulative;
      const monthOutflow = points[i].outflow;
      const fraction = monthOutflow > 0 ? neededInMonth / monthOutflow : 0;
      const months = Math.max(0, Math.round((i + fraction) * 10) / 10);
      return {
        runwayMonths: months,
        label: `${months} months`,
        isDepleted: false,
      };
    }
  }

  // If balance exceeds cumulative outflow of window, project based on average monthly outflow
  const estimatedMonths = Math.round((currentBalance / averageMonthlyOutflow) * 10) / 10;
  return {
    runwayMonths: estimatedMonths,
    label: `${estimatedMonths} months`,
    isDepleted: false,
  };
}

export function computeRecurringForecast(
  schedules: RecurringSchedule[],
  currentBalance = 0,
  months = 6,
  startDate?: Date,
): ForecastSummary {
  const points = computeProjectedOutflowSeries(schedules, { months, startDate });
  const totalProjectedOutflow = points.reduce((acc, p) => acc + p.outflow, 0);
  const averageMonthlyOutflow = points.length > 0 ? totalProjectedOutflow / points.length : 0;
  const runway = computeRunway(currentBalance, averageMonthlyOutflow, points);

  return {
    points,
    totalProjectedOutflow: Math.round(totalProjectedOutflow * 100) / 100,
    averageMonthlyOutflow: Math.round(averageMonthlyOutflow * 100) / 100,
    runway,
  };
}
