import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

/**
 * Two-handle range slider built on the same Radix primitive as Slider.jsx,
 * but with a transparent track/range so a background gradient (drawn by the
 * parent) shows through. Two thumbs auto-sort their values so crossing the
 * handles never throws. The handles are the upright bars of the Levels-style
 * threshold slider (`.level-knob`); a parent that draws a histogram above its
 * colour strip passes `items-end` so the whole area stays draggable while the
 * handles sit on the strip. `label` names the slider for screen readers:
 * Radix would otherwise call the thumbs just "Minimum" and "Maximum".
 */
export const RangeSlider = React.forwardRef(
  ({ className, thumbClassName, label, value, min = 0, max = 100, step = 1, onValueChange, ...props }, ref) => (
    <SliderPrimitive.Root
      ref={ref}
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={onValueChange}
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden bg-transparent">
        <SliderPrimitive.Range className="absolute h-full bg-transparent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className={cn("level-knob", thumbClassName)} aria-label={label && `${label} minimum`} data-testid="range-thumb-lo" />
      <SliderPrimitive.Thumb className={cn("level-knob", thumbClassName)} aria-label={label && `${label} maximum`} data-testid="range-thumb-hi" />
    </SliderPrimitive.Root>
  )
);

RangeSlider.displayName = "RangeSlider";

export default RangeSlider;
