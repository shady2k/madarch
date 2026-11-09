/**
 * The graph store of the fill's two record passes (decision 0034): the one
 * graph's schema and the records its tree and history passes write and read.
 * The temporal graph of decision 0028 is gone; a caller that needs a version
 * reads git's own history or the journal, never a versioned row.
 */
export {
  RecordGap, commitWithPaths, createRecordSchema, fileFacts, fileHistory, folderChildrenOf, folderFiles,
  graphKindCounts, listDirectories, listFiles, listRepositories, publishHistory, publishTree, repositoryFacts,
  type FileDate, type FileRecord, type HistoryCommit, type HistoryPublish, type RecordCounts,
  type TreeFile, type TreeGitlink, type TreePublish,
} from './records.js';