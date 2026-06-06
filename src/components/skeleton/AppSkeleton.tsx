import Skeleton from "react-loading-skeleton";

type AppSkeletonProps = {
    width?: number | string;
    height?: number | string;
    borderRadius?: number | string;
    circle?: boolean;
    className?: string;
};

export function AppSkeleton(props: AppSkeletonProps) {
    return <Skeleton {...props}/>;
}
