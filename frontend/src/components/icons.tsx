import type { SVGProps } from "react";

/** Íconos de trazo propios (sin dependencias). Heredan el color del texto. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, strokeWidth = 2, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const UploadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 16V5M7 10l5-5 5 5" />
    <path d="M5 19h14" />
  </Icon>
);
export const VideosIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="3" width="10" height="16" rx="2.5" />
    <path d="M17 6.5h1.5A1.5 1.5 0 0120 8v11a2 2 0 01-2 2h-6.5" />
    <path d="M8 9.2v5.6l4.2-2.8z" />
  </Icon>
);
export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  </Icon>
);
export const BackIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);
export const NextIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
export const DownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12l5 5 9-10" />
  </Icon>
);
export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);
export const ShareIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M5 12v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
  </Icon>
);
export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Icon>
);
export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
  </Icon>
);
export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9S9.5 5.8 12 3z" />
  </Icon>
);
export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 003.4 0" />
  </Icon>
);
export const SubtitlesIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M7 11h4M13 11h4M7 14h7" />
  </Icon>
);
export const LinesIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h10M4 18h7" />
  </Icon>
);
export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const RetryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 0113.7-5.6L20 9M20 4v5h-5" />
    <path d="M20 12a8 8 0 01-13.7 5.6L4 15M4 20v-5h5" />
  </Icon>
);
export const BlockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </Icon>
);
