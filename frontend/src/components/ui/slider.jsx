import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

// Radix puts role="slider" on the Thumb, not the Root, so the accessible name
// has to land on the Thumb: `aria-label` is taken off the Root and given to it.
const Slider = React.forwardRef(({ className, "aria-label": ariaLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40", className)}
    {...props}>
    <SliderPrimitive.Track
      className="relative h-0.5 w-full grow overflow-hidden rounded-full bg-edge">
      <SliderPrimitive.Range className="absolute h-full bg-muted-foreground" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="slider-knob" aria-label={ariaLabel} />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
