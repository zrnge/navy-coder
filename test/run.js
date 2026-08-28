// Navy Coder test suite — run with `npm test`.
// No framework: each suite asserts and pushes failures; exit 1 if any fail.
//
// This file is the running ORDER and nothing else. The assertions live in
// test/suite-*.js, the shared machinery in test/harness.js. It was one 495KB
// file with 54 suites in it, which is the same problem src/extension.js has
// and just as hard to review.
//
// Order is load-bearing in one respect: sharedMock hands every suite the same
// mock instance and resets it between them, so a suite that leaves state
// behind is felt by whichever runs next. Keep new suites at the end unless
// there is a reason not to.

const { uninstallVscodeMock, report } = require('./harness.js');
const { pureSuites } = require('./suite-pure.js');
const { undoRedoSuite, missingPathHintSuite, syntaxCheckSuite, cardRecordSuite, rewindSuite } = require('./suite-files.js');
const { retrievalSuite, semanticSearchSuite, retrievalUpgradesSuite, embedIndexSuite, contextBudgetSuite, contextBudgetLearningSuite } = require('./suite-retrieval.js');
const { sandboxSuite, persistentBgProcessSuite, shellSelectionSuite, nativeSandboxSuite, sandboxImageSuite } = require('./suite-process.js');
const { multiRootSuite, sessionIsolationSuite, sessionTaggingSuite, projectCacheEvictionSuite, sessionCacheEvictionSuite, projectRulesSuite, projectFolderSuite, globalProjectCatalogSuite, fileWatcherSuite } = require('./suite-session.js');
const { robustnessSuite, queueCancelSuite, writeLoopGuardSuite, reducedToolsetSuite, hallucinationSuite, toolLedgerSuite, historyDigestSuite, delegateResearchSuite, delegationFanOutSuite, toolBatchingSuite, planSuite } = require('./suite-turn.js');
const { costEstimateSuite, providerFallbackSuite, cachingFallbackSuite, adaptiveThinkingFallbackSuite, geminiSuite, providerSelfTestSuite, providerEndpointSuite, pricingSuite } = require('./suite-providers.js');
const { mcpSuite, mcpHttpSuite, mcpExtrasSuite } = require('./suite-mcp.js');
const { approvalCancelSuite, approvalScopeSuite, settingsDefaultsSuite, diagnosticsSuite } = require('./suite-approval.js');
const { dictationSuite, reviewRegressionSuite, slashCommandSuite, skillSuite, supplyChainSuite } = require('./suite-ui.js');

// The pure-function and jsdom checks first: they need no mock and no temp
// filesystem, so a failure there is the cheapest possible signal.
pureSuites();

undoRedoSuite()
  .then(cardRecordSuite)
  .then(slashCommandSuite)
  .then(supplyChainSuite)
  .then(skillSuite)
  .then(retrievalSuite)
  .then(semanticSearchSuite)
  .then(retrievalUpgradesSuite)
  .then(sandboxSuite)
  .then(missingPathHintSuite)
  .then(persistentBgProcessSuite)
  .then(multiRootSuite)
  .then(sessionIsolationSuite)
  .then(sessionTaggingSuite)
  .then(projectCacheEvictionSuite)
  .then(sessionCacheEvictionSuite)
  .then(projectRulesSuite)
  .then(syntaxCheckSuite)
  .then(robustnessSuite)
  .then(writeLoopGuardSuite)
  .then(queueCancelSuite)
  .then(reducedToolsetSuite)
  .then(hallucinationSuite)
  .then(toolLedgerSuite)
  .then(costEstimateSuite)
  .then(historyDigestSuite)
  .then(delegateResearchSuite)
  .then(providerFallbackSuite)
  .then(cachingFallbackSuite)
  .then(adaptiveThinkingFallbackSuite)
  .then(geminiSuite)
  .then(mcpSuite)
  .then(mcpHttpSuite)
  .then(contextBudgetSuite)
  .then(embedIndexSuite)
  .then(fileWatcherSuite)
  .then(providerSelfTestSuite)
  .then(providerEndpointSuite)
  .then(dictationSuite)
  .then(projectFolderSuite)
  .then(globalProjectCatalogSuite)
  .then(reviewRegressionSuite)
  .then(approvalCancelSuite)
  .then(approvalScopeSuite)
  .then(toolBatchingSuite)
  .then(shellSelectionSuite)
  .then(nativeSandboxSuite)
  .then(sandboxImageSuite)
  .then(contextBudgetLearningSuite)
  .then(pricingSuite)
  .then(diagnosticsSuite)
  .then(delegationFanOutSuite)
  .then(settingsDefaultsSuite)
  .then(planSuite)
  .then(rewindSuite)
  .then(mcpExtrasSuite)
  .then(() => {
    uninstallVscodeMock();
    report();
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
