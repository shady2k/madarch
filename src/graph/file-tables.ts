import { generatedTableName } from './contract.js';

/**
 * The product repository's files as mechanism state (decision 0034, item 14; the stage C review of madarch-hsqs): the
 * path index, the blob text and the entry that joins them to one repository. Every product's own repository is stored
 * here by the files producer, whatever entities its manifest declares, so a product that binds no code kind still has
 * its files in the graph. The names are the dictionary names stage B used, so a store keeps its ids; the entity kinds'
 * opinion tables refer to the same blob rows.
 */
export const FILE_PATH_TABLE = generatedTableName('path', 'dictionary');
export const FILE_BLOB_TABLE = generatedTableName('blob', 'dictionary');
export const FILE_ENTRY_TABLE = 'file_entry';
