import type React from "react";
import {useTranslation} from "react-i18next";
import {AppSkeleton} from "../skeleton/AppSkeleton";

type SettingsSkeletonProps = {
    tab: "application" | "git";
    isLinux: boolean;
};

export function SettingsSkeleton({tab, isLinux}: SettingsSkeletonProps) {
    return tab === "application"
        ? <ApplicationSettingsSkeleton isLinux={isLinux}/>
        : <GitSettingsSkeleton/>;
}

function ApplicationSettingsSkeleton({isLinux}: {isLinux: boolean}) {
    const {t} = useTranslation("settings");

    return (
        <div className="settings-window__column" data-testid="settings-skeleton">
            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.appGroupGeneral")}</div>

                <SkeletonSelectRow label={t("labels.openRepositories")} note={t("notes.repoOpenBehaviour")}/>
                <SkeletonSwitchRow
                    label={t("labels.errorMessages")}
                    note={t("notes.persistentErrorToasts")}
                    width={300}
                />
                <SkeletonInputRow
                    label={t("labels.errorToastClearDelayMs")}
                    note={t("notes.errorToastClearDelayMs")}
                />
                {isLinux && (
                    <SkeletonSelectRow label={t("labels.terminal")} note={t("notes.linuxTerminal")}/>
                )}
                <SkeletonInputRow
                    label={t("labels.cloneDestination")}
                    hasButton
                />
                <div className="settings-window__row">
                    <label className="settings-window__label">{t("labels.updates")}</label>
                    <div className="settings-window__section-note">{t("notes.updatesManaged")}</div>
                </div>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.appGroupAppearance")}</div>
                <SkeletonSelectRow label={t("labels.theme")}/>
                <SkeletonRangeRow label={t("labels.textScale")}/>
                <SkeletonSelectRow label={t("labels.avatars")} controlClassName="settings-window__skeleton-sub-section"/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.appGroupViews")}</div>
                <SkeletonSwitchRow label={t("labels.diffPanel")} width={160}/>
                <SkeletonSelectRow label={t("labels.commitLogDate")}/>
                <SkeletonSelectRow label={t("labels.rowStriping")} note={t("notes.rowStriping")}/>
                <SkeletonButtonRow label={t("labels.layout")} width={130}/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.appGroupDiagnostics")}</div>
                <SkeletonButtonRow label={t("labels.resultLog")} width={160}/>
                {isLinux && <SkeletonSelectRow label={t("labels.graphicsMode")} note={t("notes.linuxGraphics")}/>}
            </section>
        </div>
    );
}

function GitSettingsSkeleton() {
    const {t} = useTranslation("settings");

    return (
        <div className="settings-window__column" data-testid="settings-skeleton">
            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupRuntime")}</div>
                <div className="settings-window__section-note">{t("notes.gitOptions")}</div>
                <SkeletonSelectRow label={t("labels.gitBackendMode")}/>
                <SkeletonInputRow label={t("labels.gitExecutable")} note={t("notes.gitExecutable")} hasButton/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupGitmunBehaviour")}</div>
                <SkeletonSwitchRow label={t("labels.pushBehaviour")} width={270}/>
                <SkeletonInputRow
                    label={t("labels.commitMessageRecommendedLength")}
                    note={t("notes.commitMessageRecommendedLength")}
                />
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupCore")}</div>
                <div className="settings-window__section-note">{t("notes.gitConfiguration")}</div>
                <SkeletonInputRow label={<GitConfigLabel configKey="core.editor">{t("labels.gitEditor")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="core.autocrlf">{t("labels.lineEndings")}</GitConfigLabel>} note={t("notes.lineEndings")}/>
                <SkeletonSwitchRow label={<GitConfigLabel configKey="core.fileMode">{t("labels.fileMode")}</GitConfigLabel>} width={190}/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupSetup")}</div>
                <SkeletonInputRow label={<GitConfigLabel configKey="credential.helper">{t("labels.credentialHelper")}</GitConfigLabel>} note={t("notes.credentialHelper")}/>
                <SkeletonInputRow label={<GitConfigLabel configKey="init.defaultBranch">{t("labels.defaultBranch")}</GitConfigLabel>}/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupTools")}</div>
                <SkeletonSelectRow label={<GitConfigLabel configKey="diff.tool / merge.tool">{t("labels.diffTool")}</GitConfigLabel>}/>
                <SkeletonInputRow label={<GitConfigLabel configKey="gpg.program">{t("labels.gpgProgram")}</GitConfigLabel>} note={t("notes.gpgProgram")} hasButton/>
            </section>

            <section className="settings-window__section">
                <div className="settings-window__section-title">{t("labels.gitGroupSync")}</div>
                <SkeletonSelectRow label={<GitConfigLabel configKey="pull.rebase">{t("labels.pullRebase")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="pull.ff">{t("labels.pullFastForward")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="pull.autostash">{t("labels.pullAutostash")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="fetch.prune">{t("labels.fetchBehaviour")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="push.default">{t("labels.pushDefault")}</GitConfigLabel>}/>
                <SkeletonSelectRow label={<GitConfigLabel configKey="push.autoSetupRemote">{t("labels.pushUpstream")}</GitConfigLabel>}/>
            </section>
        </div>
    );
}

function GitConfigLabel({children, configKey}: {children: React.ReactNode; configKey: string}) {
    return (
        <span className="settings-window__label-content">
            <span>{children}</span>
            <code className="settings-window__git-config-key">{configKey}</code>
        </span>
    );
}

function SkeletonSelectRow({
    label,
    note,
    controlClassName,
}: {
    label: React.ReactNode;
    note?: string;
    controlClassName?: string;
}) {
    return (
        <div className="settings-window__row">
            <label className="settings-window__label">{label}</label>
            <SkeletonControl className={controlClassName} height={32}/>
            {note && <div className="settings-window__section-note">{note}</div>}
        </div>
    );
}

function SkeletonInputRow({
    label,
    note,
    hasButton = false,
}: {
    label: React.ReactNode;
    note?: string;
    hasButton?: boolean;
}) {
    return (
        <div className="settings-window__row">
            <label className="settings-window__label">{label}</label>
            <div className="settings-window__inline-controls" style={{gap: "6px", flexWrap: "nowrap"}}>
                <SkeletonControl height={32}/>
                {hasButton && <SkeletonControl className="settings-window__skeleton-icon-button" height={32}/>}
            </div>
            {note && <div className="settings-window__section-note">{note}</div>}
        </div>
    );
}

function SkeletonSwitchRow({
    label,
    note,
    width,
}: {
    label: React.ReactNode;
    note?: string;
    width: number;
}) {
    return (
        <div className="settings-window__row">
            <label className="settings-window__label">{label}</label>
            <SkeletonControl width={width} height={20}/>
            {note && <div className="settings-window__section-note">{note}</div>}
        </div>
    );
}

function SkeletonRangeRow({label}: {label: React.ReactNode}) {
    return (
        <div className="settings-window__row">
            <label className="settings-window__label">{label}</label>
            <div className="settings-window__range-row">
                <SkeletonControl height={18}/>
                <SkeletonControl width={64} height={18}/>
            </div>
        </div>
    );
}

function SkeletonButtonRow({label, width}: {label: React.ReactNode; width: number}) {
    return (
        <div className="settings-window__row">
            <label className="settings-window__label">{label}</label>
            <SkeletonControl width={width} height={32}/>
        </div>
    );
}

function SkeletonControl({
    width = "100%",
    height,
    className,
}: {
    width?: number | string;
    height: number;
    className?: string;
}) {
    return (
        <span className={`settings-window__skeleton-control ${className ?? ""}`} aria-hidden="true">
            <AppSkeleton width={width} height={height} borderRadius={6}/>
        </span>
    );
}
