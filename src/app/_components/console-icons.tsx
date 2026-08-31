import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></Icon>;
}

export function FlowIcon(props: IconProps) {
  return <Icon {...props}><circle cx="5" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M7 5h4a4 4 0 0 1 4 4v1M7 19h4a4 4 0 0 0 4-4v-1"/></Icon>;
}

export function ChatIcon(props: IconProps) {
  return <Icon {...props}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></Icon>;
}

export function InspectIcon(props: IconProps) {
  return <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6M11 8v6"/></Icon>;
}

export function KnowledgeIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5a3.5 3.5 0 0 1 3.5 3z"/></Icon>;
}

export function ServerIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/></Icon>;
}

export function ArrowIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 12h14M13 6l6 6-6 6"/></Icon>;
}

export function RefreshIcon(props: IconProps) {
  return <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18.7 6L20 8M4 16l1.3 2A7 7 0 0 0 17.9 16"/></Icon>;
}

export function ShieldIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></Icon>;
}

export function DatabaseIcon(props: IconProps) {
  return <Icon {...props}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></Icon>;
}

export function CheckIcon(props: IconProps) {
  return <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
}

export function MenuIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 6h16M4 12h16M4 18h16"/></Icon>;
}

export function CloseIcon(props: IconProps) {
  return <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
}

export function SendIcon(props: IconProps) {
  return <Icon {...props}><path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/></Icon>;
}

export function SparkIcon(props: IconProps) {
  return <Icon {...props}><path d="m12 3-1.4 4.1a5 5 0 0 1-3.1 3.1L3 12l4.5 1.8a5 5 0 0 1 3.1 3.1L12 21l1.4-4.1a5 5 0 0 1 3.1-3.1L21 12l-4.5-1.8a5 5 0 0 1-3.1-3.1z"/></Icon>;
}

export function ClockIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>;
}
