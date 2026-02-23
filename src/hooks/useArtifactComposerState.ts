import { useCallback, useMemo, useState } from 'react';

import type { CampArtifactMetadata } from '../lib/types';

function sortedUniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function useArtifactComposerState(artifacts: CampArtifactMetadata[]) {
  const [artifactQuery, setArtifactQuery] = useState('');
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);

  const artifactById = useMemo(() => {
    return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  }, [artifacts]);

  const visibleArtifacts = useMemo(() => {
    const normalizedQuery = artifactQuery.trim().toLowerCase();

    return artifacts
      .filter((artifact) => !artifact.archived)
      .filter((artifact) => {
        if (!normalizedQuery) {
          return true;
        }

        return (
          artifact.title.toLowerCase().includes(normalizedQuery) ||
          artifact.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
        );
      })
      .sort((left, right) => right.updated_at - left.updated_at);
  }, [artifactQuery, artifacts]);

  const selectedArtifactsForComposer = useMemo(() => {
    return selectedArtifactIds
      .map((artifactId) => artifactById.get(artifactId))
      .filter((artifact): artifact is CampArtifactMetadata => Boolean(artifact));
  }, [artifactById, selectedArtifactIds]);

  const toggleArtifactSelection = useCallback((artifactId: string) => {
    setSelectedArtifactIds((previous) =>
      previous.includes(artifactId)
        ? previous.filter((id) => id !== artifactId)
        : sortedUniqueIds([...previous, artifactId]),
    );
  }, []);

  const removeSelectedArtifact = useCallback((artifactId: string) => {
    setSelectedArtifactIds((previous) => previous.filter((id) => id !== artifactId));
  }, []);

  const clearSelectedArtifacts = useCallback(() => {
    setSelectedArtifactIds([]);
  }, []);

  const pruneSelectedArtifacts = useCallback((availableArtifactIds: string[]) => {
    const available = new Set(availableArtifactIds);
    setSelectedArtifactIds((previous) => previous.filter((artifactId) => available.has(artifactId)));
  }, []);

  return {
    artifactQuery,
    setArtifactQuery,
    selectedArtifactIds,
    artifactById,
    visibleArtifacts,
    selectedArtifactsForComposer,
    toggleArtifactSelection,
    removeSelectedArtifact,
    clearSelectedArtifacts,
    pruneSelectedArtifacts,
  };
}
