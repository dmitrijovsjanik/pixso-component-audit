import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-semibold leading-tight",
  {
    variants: {
      variant: {
        local: "bg-chip-local text-chip-local-fg",
        library: "bg-chip-lib text-chip-lib-fg",
        unknown: "bg-chip-unknown text-chip-unknown-fg",
        master: "bg-chip-master text-chip-master-fg",
        muted: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "muted" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
