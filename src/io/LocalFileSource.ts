/**
 * LocalFileSource.ts
 *
 * The sole implementation of `PointCloudSource`. It wraps a `File` the user
 * dropped or picked locally and delegates to the established `loadFile`
 * pipeline, so the local-first, worker-decoded, fully tested load path is
 * unchanged. Streaming and heavy sources (COPC, EPT, 3D Tiles) do not extend
 * this class; they implement `StreamingSource` instead, defined in
 * src/render/streaming/StreamingSource.ts (see PointCloudSource.ts for the
 * split).
 *
 * Browser-bound (wraps a `File`); not imported in Node tests.
 */

import type { PointCloudSource, SourceMetadata, SourceType } from './PointCloudSource';
import type { LoadResult, LoadCallbacks, LoadOptions } from './loadFile';
import { loadFile, fileMetadata } from './loadFile';

export class LocalFileSource implements PointCloudSource {
  private readonly _file: File;

  constructor(file: File) {
    this._file = file;
  }

  type(): SourceType {
    return 'local-file';
  }

  /** Cheap preflight — head-slice sniff, no body decode. */
  metadata(options: LoadOptions = {}): Promise<SourceMetadata> {
    return fileMetadata(this._file, options);
  }

  /** Full decode through the worker pipeline. */
  load(callbacks?: LoadCallbacks, options?: LoadOptions): Promise<LoadResult> {
    return loadFile(this._file, callbacks, options);
  }
}
