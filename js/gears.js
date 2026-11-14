// Virtual drivetrain for single-speed setups such as the Zwift Cog.
//
// The trainer in simulation mode derives road speed from flywheel speed and the wheel
// circumference it is told. Scaling that circumference by virtualRatio / physicalRatio makes
// the trainer behave as if the bike were in the virtual gear: a harder gear means more speed
// (and more resistance) at the same cadence. Trainers that reject the wheel-circumference
// command fall back to a grade offset per gear.

/** 24 virtual gear ratios (chainring ÷ sprocket), close to the Zwift virtual-shifting table. */
export const GEAR_RATIOS = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.40,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];
export const GEARS = GEAR_RATIOS.length;
export const DEFAULT_GEAR = 12;
export const BASE_WHEEL_MM = 2096; // 700x25c
export const COG_TEETH = 14;       // Zwift Cog

export const ratioOf = (gear) => GEAR_RATIOS[Math.max(1, Math.min(GEARS, gear)) - 1];

/** Wheel circumference (mm) to send so the trainer rides like `gear` on a chainring×cog setup. */
export function virtualWheelMm(gear, chainring, cog = COG_TEETH) {
  const physical = chainring / cog;
  const mm = BASE_WHEEL_MM * (ratioOf(gear) / physical);
  return Math.round(Math.max(300, Math.min(6500, mm)));
}

/**
 * Fallback for trainers without wheel-circumference control: extra grade (%) per gear,
 * scaled so the neutral gear adds nothing and each gear step feels like a real shift.
 */
export function gearGradeOffset(gear) {
  return (ratioOf(gear) / ratioOf(DEFAULT_GEAR) - 1) * 4;
}
