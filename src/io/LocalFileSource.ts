/**
 * LocalFileSource.ts
 *
 * The `PointCloudSource` for a file the user dropped or picked from their
 * device — the only source ships. It wraps a `File` and delegates to the
 * established `loadFile` pipeline, so the local-first, worker-decoded, fully
 * tested load path is unchanged; this class is the clean seam the v0.3
 * streaming sources (`UrlSource`, `CopcSource`) will sit beside.
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
