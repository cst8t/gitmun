import React from "react";
import {
  GitCommit,
  GitBranch,
  File,
  Check,
  MagnifyingGlass,
  CloudArrowDown,
  ArrowLineDown,
  ArrowLineUp,
  Archive,
  GearSix,
  CaretDown,
  ArrowLineRight,
  ArrowLineLeft,
  X,
  Plus,
  User,
  Key,
  ShieldCheck,
  Terminal,
  PencilSimple,
  Globe,
  FolderOpen,
  Copy,
  ArrowsLeftRight,
} from "@phosphor-icons/react";

type IconProps = { size?: number; className?: string };

export const GitIcon = ({ size = 18, className }: IconProps) => <GitCommit size={size} className={className} />;
export const BranchIcon = ({ size = 16, className }: IconProps) => <GitBranch size={size} className={className} />;
export const FileIcon = ({ size = 16, className }: IconProps) => <File size={size} className={className} />;
export const CheckIcon = ({ size = 16, className }: IconProps) => <Check size={size} weight="bold" className={className} />;
export const SearchIcon = ({ size = 16, className }: IconProps) => <MagnifyingGlass size={size} className={className} />;
export const FetchIcon = ({ size = 16, className }: IconProps) => <CloudArrowDown size={size} className={className} />;
export const PullIcon = ({ size = 16, className }: IconProps) => <ArrowLineDown size={size} className={className} />;
export const PushIcon = ({ size = 16, className }: IconProps) => <ArrowLineUp size={size} className={className} />;
export const StashIcon = ({ size = 16, className }: IconProps) => <Archive size={size} className={className} />;
export const SettingsIcon = ({ size = 17, className }: IconProps) => <GearSix size={size} className={className} />;
export const ChevDownIcon = ({ size = 16, className }: IconProps) => <CaretDown size={size} weight="bold" className={className} />;
export const StageArrowIcon = ({ size = 16, className }: IconProps) => <ArrowLineRight size={size} weight="bold" className={className} />;
export const UnstageArrowIcon = ({ size = 16, className }: IconProps) => <ArrowLineLeft size={size} weight="bold" className={className} />;
export const DiscardIcon = ({ size = 16, className }: IconProps) => <X size={size} weight="bold" className={className} />;
export const StageHunkIcon = ({ size = 16, className }: IconProps) => <Plus size={size} weight="bold" className={className} />;
export const UserIcon = ({ size = 16, className }: IconProps) => <User size={size} className={className} />;
export const KeyIcon = ({ size = 16, className }: IconProps) => <Key size={size} className={className} />;
export const ShieldIcon = ({ size = 16, className }: IconProps) => <ShieldCheck size={size} className={className} />;
export const TerminalIcon = ({ size = 16, className }: IconProps) => <Terminal size={size} className={className} />;
export const EditIcon = ({ size = 16, className }: IconProps) => <PencilSimple size={size} className={className} />;
export const GlobeIcon = ({ size = 16, className }: IconProps) => <Globe size={size} className={className} />;
export const FolderIcon = ({ size = 16, className }: IconProps) => <FolderOpen size={size} className={className} />;
export const CopyIcon = ({ size = 16, className }: IconProps) => <Copy size={size} className={className} />;
export const CloseIcon = ({ size = 16, className }: IconProps) => <X size={size} className={className} />;
export const SwapIcon = ({ size = 16, className }: IconProps) => <ArrowsLeftRight size={size} className={className} />;

// Window control icons - bespoke pixel-precise controls, do not replace
export const WinMinIcon = () => (
  <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
);
export const WinMaxIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
    <rect x="0.5" y="0.5" width="9" height="9"/>
  </svg>
);
export const WinCloseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
    <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
  </svg>
);
