import { forwardRef, type ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
};

const variants = {
  primary:
    "bg-primary text-primary-foreground border-primary hover:bg-primary-hover hover:border-primary-hover",
  secondary:
    "bg-transparent text-foreground border-border-strong hover:bg-secondary hover:border-foreground/30",
  quiet: "bg-transparent text-muted-foreground border-transparent hover:text-foreground",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "primary", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-5 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  ),
);

Button.displayName = "Button";