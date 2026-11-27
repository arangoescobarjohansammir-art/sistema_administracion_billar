export const billiardRate = 6000;
export const billiardTables = 6;
const timeChargeStep = 500;

export function elapsedSeconds(startedAt: number, endedAt: number, pausedMs = 0) {
  return Math.max(0, Math.floor((endedAt - startedAt - pausedMs) / 1000));
}

export function timeCharge(seconds: number, rate = billiardRate) {
  return Math.round(seconds * rate / 3600);
}

export function roundedTimeCharge(seconds: number, rate = billiardRate) {
  return Math.round(timeCharge(seconds, rate) / timeChargeStep) * timeChargeStep;
}

export function durationLabel(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
}
