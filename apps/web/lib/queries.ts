"use client";
import { useQuery } from "@tanstack/react-query";
import type { DocumentListItem } from "@lomi/contracts";
import { api, IN_FLIGHT } from "./api";

/** Shared by the sidebar queue and the overview; polls only while something is extracting. */
export function useDocuments() {
  return useQuery({
    queryKey: ["documents"],
    queryFn: api.listDocuments,
    refetchInterval: (q) => (q.state.data?.some((d) => IN_FLIGHT.has(d.currentVersion.status)) ? 2000 : false),
  });
}

export type QueueGroup = "attention" | "review" | "extracting" | "done";

export function queueGroup(d: DocumentListItem): QueueGroup {
  if (d.currentVersion.status === "failed") return "attention";
  if ((d.progress?.pending ?? 0) > 0) return "review";
  if (IN_FLIGHT.has(d.currentVersion.status)) return "extracting";
  return "done";
}
