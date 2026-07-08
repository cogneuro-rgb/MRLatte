import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

/**
 * Two-handle range slider built on the same Radix primitive as Slider.jsx,
 * but with a transparent track/range so a background gradient (drawn by the
 * parent) shows through. Two thumbs auto-sort their values so crossing the
 * handles never throws.
 */
export const RangeSlider = React.forwardRef(
  ({ className, value, min = 0, max = 100, step = 1, onValueChange, ...props }, ref) => (
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
      <SliderPrimitive.Thumb
        className="block h-3.5 w-3.5 rounded-none border border-white bg-black hover:bg-white hover:border-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        data-testid="range-thumb-lo"
      />
      <SliderPrimitive.Thumb
        className="block h-3.5 w-3.5 rounded-none border border-white bg-black hover:bg-white hover:border-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        data-testid="range-thumb-hi"
      />
    </SliderPrimitive.Root>
  )
);

RangeSlider.displayName = "RangeSlider";

export default RangeSlider;
