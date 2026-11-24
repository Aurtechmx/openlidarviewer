/**
 * mapSheetFields.ts: the map sheet dialog's options, with the company details
 * this device remembers read in for Prepared by.
 */
import { mapPreparedBy as suggest } from '../render/measure/mapSheetExportOptions';
import { rememberedCompany } from './companyStore';

export * from '../render/measure/mapSheetExportOptions';

export const mapPreparedBy = (): ReturnType<typeof suggest> => suggest(rememberedCompany());
