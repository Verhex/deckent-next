#!/usr/bin/env node
// Documentation-preservation check: every non-empty line removed from the given documents (vs a git ref)
// must still appear verbatim in the current document set (PLAN, ARCHITECTURE, COMPLETED-PLAN, .deckent/docs/**/*.md), or have an authorized privacy replacement.
// Normalisation: trailing/leading whitespace trimmed, leading markdown heading marks ignored (heading demotion when a
// section moves). Table separator rows and horizontal rules carry no content and are counted separately.
// Usage: node scripts/check-doc-preservation.mjs [--ref HEAD] [--verbose] [PLAN.md ARCHITECTURE.md]
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const ROOT = new URL('..', import.meta.url).pathname;
const runGit = promisify(execFile);
const args = process.argv.slice(2);
let ref = 'HEAD'; let verbose = false; const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref') ref = args[++i]; else if (args[i] === '--verbose') verbose = true; else files.push(args[i]);
}
if (files.length === 0) files.push('PLAN.md', 'ARCHITECTURE.md');

// PUBLIC-RECORDS-1 (owner orders 176a and 176c). Each entry binds the path, base line number,
// SHA-256 of the original line and SHA-256 of the normalized replacement in the same file.
const privacyReplacements = new Map([
  ['.deckent/docs/architecture/approval-and-delivery.md', new Map([
    ['687:429b993cb4c9b760aae815c878d3dc93eda5c502658fc603b42bf249325cd1f7', '4a730d31ad9f87dfbf84f8ed4d8c226cb8b9ad7d6dc8ca223ab95d5dde3714c4'],
  ])],
  ['.deckent/docs/architecture/decisions.md', new Map([
    ['455:be146dfddc9f40edfe3a1bad05f1b6ed806143d446550f6e0d71b17301bd51a3', '220010cee3f9a38fa7c0e03bcee47c4edd43a213ff23b815c9310103ba76b0bf'],
  ])],
  ['.deckent/docs/architecture/modules/terminal-surface.md', new Map([
    ['10:833a11865cf0fa65ded9c3c58b725b5ecad457dfd147cd4d7328ee7d0ab73221', '9fe0885e0d2eb2c8b205b3328ec2e1d9165a17bd8d747d258d505f74ea636f19'],
    ['492:f64ff22eda94382267ce2201c07e969136cc4cf645b7f484eab197202c852615', '6ff52a3e787cdf1ad6153c5ab7077c5c3a76de9f73416769855e21c908211909'],
  ])],
  ['.deckent/docs/archive/2026-11/owner-targets-2026-10-05.md', new Map([
    ['16:6b78c1ddcc6875c1e5728895ef2d170ecd7acae9be858a67411635aecf83de20', '4228e11cc8ba5e78cee97839131261193965c9edebec971ab9e62baa43418b9c'],
    ['22:596510b1ce87f0480ad96f8829750b99216a4f3c946cbba8c306959bc3e16150', '25c38d1bfe40a1313d31efc848c2d6412343b8e967747643e72bbb9bc8752b1d'],
  ])],
  ['.deckent/docs/core-memory/MEMORY.md', new Map([
    ['1:1b65753b8e125886cde5d6b628bd9696c4c027443953178c42045a51e90b6680', '1254ab329c779db98537253e429f57097c5a158764f091a23ba8f6a7c8b4ffae'],
    ['16:bb807ed7c1e099db9a881997825e34f5975da0823542f7da9907b4b00d083680', '4366e4f8ece29dd3c38b65b3844f89cb8fe03ae2ed6a50cb4dce08d7c4746df5'],
  ])],
  ['.deckent/docs/core-memory/law_documents_and_memory.md', new Map([
    ['3:31140ad8b7be3a5c89a2703872c059f5086e5392ae1b4e41f0b09354960b8d30', '45b104e35e02292d2380b6de4d7ba6eb09a57a853ad563d36ba49a1db558e787'],
  ])],
  ['.deckent/docs/decisions/owner-decisions.md', new Map([
    ['177:acbd0240b986b7bb186d734ab055d0b8572525e5d052f0c91adfdfebad05c866', 'fd455fa2efd33eab172a1dcc212026b5aa9ab757c76400ece20a2d61db7ca0bf'],
    ['400:dbde54059ec121e6384c065d45b41ee6e51b4beffbeb3e24040447fc073c5b58', '9ad8f7ea2e2a3fa9dbbc0e64857f2749e7198b393f379847219d2b3af4c9ff6b'],
    ['401:130f9cd77f2cc333fbcc40f43b56ae63cde16f80c3b0a4c87c6f03503841e20c', 'fed8509d5b907ab34730db8389c363ae1798854a2ac2733cab4a7672ce91212e'],
    ['402:96621a18e13e0d2607dd541ae0545d9bde68162561969e9191e76cd122a5a951', 'da2ba1359ab08ca2a3d05df1e910fa4dbc12d22e86be9dca7933ea709e99e83a'],
    ['403:ae499976dfadcb869c0c2deef942d880fdf8d534af056fb63319bc32713bac64', 'd1d2eb1e2d8439bc8ebcb15913eb708b67891946c359f6fd5f8af0e274d87e37'],
    ['404:fcc880c46e3a67e93ee61a2692874daab1416bef312501a247111d36b10b8a27', 'f1f9800844f770b56d391b633296042c4d1322778f8dbbfe6ce3b36e403cc56e'],
    ['405:c9ef488a69cfddae641e4d552be98bc729843584b61edd52c85a4a32a4c37adf', '644b2e17caa8fd4ffe7fd8d93c2d93becd58d8bb9475f22a92a99faa20ff264e'],
    ['406:37dc8f3c4a22dda456f799217ac6432f83cefdfe92171c43b8704002bc66c0eb', '4a41c86b8529d93cbfee4035cbc112c76c4b9566e0ec6e0b98dbb436c6bf8681'],
    ['410:1a858c410f0b1a55027b0f3bfe50def394b4ef2f8c0413c56a3ce3f433afe124', '3db43268a197c7bafe87077c01f65fc08e53f8e73dc35f1fe6df66d05a47209e'],
    ['411:b3fb261637f3efdb6fb8a4fb69313a28035432140422f1ce9dcb2bd4bdfeef98', 'aabc06a3bfb970e2993e99601587e423ce8771e0cd29a9798f0b07a8bb0011b2'],
    ['412:106b7554fdd9b22945b1d9e2e12853872ecd17210aacf7d3501fd94739705e9a', '460e6716c08c905c13e770c4f9780b328480136fd63099b2a01401d75575b72b'],
    ['416:dcaff892ddf3b8b1bf19cf737e893ff4f03fcac3652bdf3cd54e2362b6d37314', 'e17f4f5b29f180d732415eff2a40b6769555cf66fd3fc585b7b4ca50f38136bf'],
    ['417:d2cb6ad1aef6adbad19d25ce324d664385679bd3f476e5827c546c1d1779ac91', '61fe567b9943d9d2d9dd5b7e69f31a1ddb4b0cef7e10676b490bbbdd5882eb9d'],
    ['418:ee4d7bf3f2c757f2c167e27d6c7f92c6bf03eba6725867a40b608dc553565532', '268c963336c483bcabe0b8baefc1538910212d2f45055ef7783c938d70fecb99'],
    ['419:af5f167da8f87e491775dff3db4a867adcdf9c171449791f5cb990865a66b075', 'd299c49b2b18075b5bef893959a5885be62390660e8ff0ed01adc16c180e6c05'],
    ['420:1c1beea5bd1f20abeb789d081bbe5501d6f7e0f7c90acbac0da390f470aeac4c', '5cc15bc3a4963c008a85a24a670078a06119a2ff52aa8083e238ec43225e472c'],
    ['421:a3be4cc6dbc0a28cbcf1399360fa2282d53c13775efdcb6e65363f1eeb6ca393', '80b759c0bc717247cf509c0ebaaa76efbab1af4df92eeecb61782b0394c65104'],
    ['422:257ec6d7babd3046726b6da685fe5d31e71b166a7d067a09ca6d4c9556890c0b', 'cd9f3557250008925d20358f94339eb6f9162941b33a633d7f92e4a4b9a2ddec'],
    ['423:e34101f0ffcd4aa6c7111c4ebc26c319c975c9e4804f12b767f4a0040d9ad3c3', '8f77ab5a810a385fd27baa062f0a18bb55221b653aaa44986319bc54c24239da'],
    ['424:9f2a6f3cfe87028c6c6d43e92dae0c37cd353c429af46b1609b6e7fe8a8f800d', 'a0971b6c61cc4ff0f15da2f4aebe57e4dccac1bbf73377f3d4dccf0581f230c3'],
    ['425:6f9057212d3b4693c535dc589dfd3561de0b05bae3cac0d0f16639131fad2810', '6b569187d19c3872e20b7abcf8139a0ee85f98eecef7f8ca83717228dc4cd753'],
    ['426:0cf6a8f6e644ea3e97d9fca954ec2dcbc3e35e1b557d79333905164da7993824', 'f23598f2890b54ada38e68cab091a2528eaf84a10a433d9a4861f7095651d785'],
    ['427:ded2bf68ce2407fbf53439c0f7d2ef88967cb2c19f15dcc0ee9d33a7632097bd', '6175c8f65a6d5bd7bbbbb73bdbe67b2aba5b62fe7dfdacd5662b6e79c318e284'],
    ['428:c3cb6e7538f477f013470f582f8fdc305f37d79a4c37eb77ab842694da1b52ce', '8d7d82e64455e76bb0e07892f15fee873267b417b6b9167824f1b6cb25860efa'],
    ['429:36dd80c846cf59876bb7c72451333cfbf43a142cd3295ad636e9598d91923029', '67f72dc0f7ea2805ed2d76270189aeac8f7a04c7e94ffd979d1f9e11ba444ef1'],
    ['430:03a3ea26df85a373652644c00b540757d77f6f8a543902360d76057ece8843a2', 'ae08decedd369a33afa27f33954619080b7b3616a3fe17c06201bacff14988a6'],
    ['431:59b928d10138dc56e28c36204e9c9591aeb1d90998c09417e931955ed35e9bb7', '7050e1c6e4e20067ed16089de79219d17565e660b4dfe16321f9c8d9f69b1e37'],
    ['432:bec361d943edfc58bc0fca95cb55e81f6c4517f5f78f76c8ffb66a40b86f6feb', '958381682e854208b8055d69ac924937ba3a47cefc78e3e8e10cd74a7fddb270'],
    ['433:91b23b4031e6ab82aaf87a09ab6ef8104dd5286d46eaa4fb720c4d8b3f42c077', 'b9f4f072f354699ecb02a10a9246bb2f8eeb954481ae497586b0d45f097fb7e2'],
    ['434:c1f87dad4ce0f63bab85b91744cd16e5496c250456bf2f12ba2f5bef85c58acb', '55a0fbaa4817b02d2778e6fa483d58cbfacb099d48d1a0b72dc57f939cd07e23'],
    ['435:a3d2d93d51a23894a2a96dcd467bb648ebd35bc9a044a268367ad279a9ba23d1', '9f4a5ef2547ee058ab6219c35e25a56cdb3c44653e61ed9820b30f15794dfe94'],
    ['436:7f1a31371e28ea4f6febd0536361ba918c6c57e75993e52fc2a01426bd7fb5f5', '6eac7660fb90d660cf91de7e92c4b7d484c2b6576237eb05797c2dcd47991663'],
    ['437:6db3a5b6f74b54ef370cc6b25e2892498545e303b35ad110b9ddcd4fb72ac9df', '93e52dd0d09edcea4259a61137c241fc9e1b12c6e04522d0f2933cdffbdbd99b'],
    ['438:27becb9f2a382625ba4488bc9bccb3923afe89a4d8c666d867d8e0e21f6382d5', 'eacc051e46c464abcdf223428cc1b31e57e8e46f25f848df023731fc87b1b0e3'],
    ['439:49b5d31708e06dd886b457304e4db2088eb510414b23b582550496316206e1e8', 'de0f4fb04d5885a1b26e9ef0a6360c0b31cae55c28cff75da0eff3774a044f44'],
    ['440:50341915ccae12768d11dfa307cc20f2e20c9012e24054eeb53b3b32e6894c14', '169de2feb1adf305bc62aeaf2ae2b1d633aa489f0cb6d3ea8e49cdce1e3368e6'],
    ['482:81b24c2bb678420a01043b62a7f8f01d878ca6e952dc33cd32254728d9fb9ed1', 'cc65d8393be5759096c9478715ff864e8fc8b29140ca3d0cfcc11f1b6789b5f2'],
    ['483:b87f18b288a22d936221fde01147fbef6162e645b6e10b980e50abe63ec75ac9', '31100e4d7fb2e97cd0b357f0a7e58464f99389e2f41f1adf9858a8b8e6ec5793'],
    ['484:ca9dc09142054e76575dd5c6e36c8fcd85a6ab5def93be28736ea4240d1cad97', 'e078bbba750a4211892cc485d962177acca5ff00129c910d65fcc72f906e12db'],
    ['485:2460e656736d5946e25ad5e2e9505631517748b733229e59f6f053025baafcab', 'd171b3c7c0f22fd2ae5c0af1a4f620ac1ea7de0840097c040f65089abb3bb1b8'],
    ['486:c3015ed08aa4485b84e41b74189f1a83d497e973e39b1b5ffdebf3a28ac7d9e0', '62cbeeffa79517d2e92e20576bfd5d06b5adfd1410f887d462b48e4662bca56e'],
    ['487:e3a5b7a97353dd1004cefe8a67a5623249122071cd66d2379f9818d2c1681377', '59008d892cb9ef495023aac63f898dcfb603fe7ddb8bc80e537f248284578859'],
    ['488:a03b9053a847ae4073c4c042601b6dc3ae9e1362dc18006e66df4557ce7c6997', 'b9d6f304af471c46413b6c23597d28c93c448cf0503eb6e79dd7fe0dd80dcee6'],
    ['489:feb36ccb05e2ce70c488fc84056a0c15a06ea6d96c7c8c4e02752bdb4979d37b', 'c8d689194b089537a0b0216313dffca18abc7effe3bee0d573ea7916aae4eaa4'],
    ['490:d78132881df25173ee07c7c29469c5e0364439dc03fbe9e6796f79d78cc5fd65', 'd56ab1526c02d28860ee2821bc7dac5063d854dc17772a3b6df528439a6d8636'],
    ['491:ccd5825b2d9add956d639667ae6d7488d0d2d4cad1beee3007c52e8448cebd0b', 'b8ee3bac3a6ddc878e2087811ba337cd7d9c02400c0cb506d955428d6dca4bf5'],
    ['492:e11573ec2d6f1c8c1221b25e5564a00ca0efcbf1210d0a85454cff5c6f4015b2', '39415bca1ee813996a035540f2ef30ef558720b242aad41d462450bfd0e4e832'],
    ['493:3a838c0996617a649174458a32c5db56eb9e7156525704adc3bf15b4b2096807', '6fc5e434d45cd2e8a8d3984d69e4cc17a2ff4a7392f7a822f760a1acbd01bcfb'],
    ['494:c8cd3def748a8a9d2f31951ff9394079f1c40924a23ed582f892a84ee39eeec0', '45953c94ba0a0edd598f4cb43ae9dc216924805cba7eb695834ac1586eea20e8'],
    ['495:6436506c00610d9d54056fe97ca900dac7ee29ca529cbc4f14f6a04d3313e293', '3d6bdcc02b5f600d6ffed3f3a734b149db8ad6515035049695a54c4649e51c93'],
    ['496:d64223e04c8e98da0344a1cf80f5b7d3624498ddb81549f726ad384e51b3ee15', '32291be591584dffe167eff5a3067e76bd37268c5bb7211f48cbd5e07f45bad4'],
    ['497:b08ac62092a7359fe7144a753ee245a8d57b0b4df1604ca170cc71cb6026f53d', '8fea6254f80c68c722791d705698c6a6773bb29356cefe025070b47b80f83d13'],
    ['498:c3edcdf6d1c361080b2d2a6bbd0a0e81f9b1eaba027afda33ebe6f18ae4fc286', '9fc10b8aaa3ca15c3f282b3f90983c02e571a7bc57df6c38ea660b592323d8fa'],
    ['502:29ce3cfc867a561529e453825c998f143a6dc84c47663aa386269bd364906a5c', '70b8a0a9a9c4067d913e111ef8d09cd3ae2fc3f1dd94e4c9eacd9b73de02122f'],
    ['503:214cdd6fd59e9651e1b77791189136f59748673580a70405e8336d04da1ade57', '01763984814084926702a8fa3fd1dd2859dfff203b30a2314335c1ce4626b50c'],
    ['504:60181c3bfbc5a2a147e31254611853d92604e70e18a5dfa631ee106fea1f8b10', '14777fd56666cf57ab55f6b46463035823f861fd04c58964e781a22dd1b29f87'],
    ['509:01808aae8d9ddb53be0d047567a4149ee706575419c2d2f8b7d9c404802ae66a', '7791ee6f4bca2d966d5394694752828531b84703cc66187d09f74959862747d6'],
    ['510:1dcad8099349a7f4b977e6d8cc41de9950caab4edd4bceb273df032ab4850872', '967589fe1a52e2bd86ace61be41321ec5c01659f7c91475671ccd9a5c89774f6'],
    ['511:5b8a5f2f7450709863f538caf3c0bb11eae224cf17e9c0f78eee88cc1aa8d6f1', '3d2b716f291b7db4ef9606574505de7ad60871595be6b52544ab20784d3ec528'],
    ['512:0fc7ead62f2da52b4c9436045c71004a1d27a72e5acd9af193116f190d5edac1', '81a909f7e72c7cd99d0f0429f305274fd2c579a4d5956fa774ab45b04840a8e8'],
    ['513:77663b83961d975b33b3b27b3ccfc3b43f749a86bdad56846118fa6f2b6bb6c1', '0d5d6747e2ed0fc7cd5677f35ee0e00a8423513534b84bc0d9dc009ce200e77b'],
    ['514:e8b526a5534f14ae6e4f585db6bbc45143ec2800f5d3e7ebc55521316dc82637', 'c0426d30ee4119e75ab0597067def973f37b87295af213a4e54bc69a61a04625'],
    ['515:a5ab31682e626d58830e64b97e1d8ccb153f645b041ab6102ad9d3ad0dbce2d1', '364193d758c59aa9a275f889737262a893a19550d2c72c434254734589bc94ea'],
    ['516:3a7a9b08015f2df07bf4c25fd0829bedb786f63184f4d6c5a91c47aa2c7e9ec6', '8794e224acee5215d6aff0cee13463ac1462ddf45c8ab7bf77e65ae626bb9f82'],
    ['517:94fdc0c50c8d06c226e1bdb17155e3a52598bcd939dda4e556cb2aa11742a2a3', '1ae409fe1b32fbfa618bc69315e35cf4f3ded56f67cf20cd54164eb03e7e95d3'],
    ['518:38e8789566bc2a9529ae2ccf937089332d0015b616d09cba0f2859b91e622af7', 'ba2061c3f2bca6a3c9aec9f03dd5ae65281c73abda79b1d5bb2cbefcdb6eec79'],
    ['519:932e481626cdd84e1b31a4fec64e70946bc1db0f2a8c45b0ebba02684910d15f', 'c2765fc2c29eff5e02f129f231f9f864c26ad8866ee1e423e1ab63727f0469bd'],
    ['532:fc0dbd0d44a286032c4eaebb6feb40a1f68eeefb0513ab3067b2e913b331f849', '2527fce05786bf480e593c983bfb9368ea514584fe935e86c9860099b65a3a17'],
    ['533:84067946cf4d446d7fae93bf980e932ce75a0533cce55c4c61efb7ad4fc9fc53', '751afa21ac92cda5e550223ce0ce870738341876e853dadce2659be59551d0b1'],
    ['534:73b9a1dddee1fa0a51abe764af8c40aa544d2fd3494928ce47606c283465156f', '72defe46e6a02caba1d3b911eec20d3568aec563271b816271f237f3a30eb235'],
    ['535:59ae57a525282c1c981311ce85e3f34aeba47018d3a24832716b5a65284992dd', 'fa803dcda92b6519662e8b0c72dfcc813f856b5928eebb70abdf35b4e43a3644'],
    ['536:fa363146a46a657186800d8d4effda0c84bf3c0e3fd091fa0692ea5250147a24', '4f6187b3a39316c8cc712318f4f518394f456b21878bc1996c528f2bbd2c33ce'],
    ['537:c37a81a018145f51ef24c4511a00064fbe20764d954b5aba5f7535ddb575fae6', 'e03bfe6a02f27a2981762122475aab4347c957d16a0f8ad42920be65fa544ad4'],
    ['538:e9c8d2e09cfaee030e72794db56c0b232867c6ca81e059b06d00023bc6fc6bf5', 'a358c66194b953b9d1b9182f984b159a5aff0ac4691d29c4da3eb960e5cf3b11'],
    ['613:a3fb23f78235b4e283a3c8f829b52b40acf141295f29d85a381e2152bdea8574', 'b22f47b8078b2aa33e94f597350204572308ec4a6310875bab9e0bdd29a37293'],
    ['614:685da8195c78cdf1c91e0037928c426f26a60930b9fd9628f1d7f899db24d585', 'c8a835c01ca11e9eaa29faa6865901b177cc54006f3d5a74c08429ccfe4a9b55'],
    ['619:5051540e26d718f1d76e083bbf2fa1415a0abf121dc9537df314dafd9edaef63', '20f7bf21dc8b89c9db4b57387fd611df0fc0f15e72404d50645e148989cc7f6f'],
    ['1009:5397ad8d028ef4a417f02a47416a20fff9e388c4bb5d1ec08dc1f5dc6ed1ff8c', '777d9cbe983b0e3bd4923ef874fc621c5204dd5df2bfa81f62e417688debe3fb'],
  ])],
  ['.deckent/docs/plan/archive-2026-10-14.md', new Map([
    ['317:81409d8ac74d70c2a80c9f9de12d355f2d886c1886b9f7d8ee741fd4cdbcdf78', 'dd308ed0e9d16af4efa223a49d0b4de1f703c112100999f003d6feb9a41e66e1'],
    ['396:6662d1b7dfe440eba8e39ddc9f32d30b84e182506c61b26d50059799407cec9c', '2a74ad4705daa7b7432845e0a66973007e00bfa1e4d53a342f23d7c74142729a'],
    ['441:031b51bcb5f1f6e2ac7256cfe70890f058fadc359f15ace5271ce2d543ccf55a', '1fee8f4dee0cd312285807777d13fbe01c3fdf906e924a5b9e4172ab1954380e'],
    ['469:d4100f94b94221d96c74d75463ff8afb6cfcec152e643d5a4b51f5001f6b57d6', '71dafa473a656a45b6bd1333a49fca463977af29eb583a42dc111f24f6047d76'],
  ])],
  ['.deckent/docs/plan/cli-review-2026-10-19.md', new Map([
    ['219:a31cf6454aa382b133f00c283a81b5b948e364a66386d06d734e7d57f47aaf6e', 'd168ecafa926a3f6f887e46535995446f3c8c199d77a746359de1a29584470fd'],
    ['253:f712b5ae7f8618bd3d85b15c460df4dcbe3f472849515bb9f13364a8b6dad922', 'f79f58194700fddd3b1872364137cb7d70c8f6a03d33aefceb00eec889470bc1'],
  ])],
  ['.deckent/docs/plan/native-platforms-2026-10-21.md', new Map([
    ['104:a85b881ffa5c6219056b9be6be922384d350741359d201faa889de7394b36dde', '15056b99c710353b30be922dd71bebd6d56890eeaebdcd0f7b1402e7ac96cb8e'],
  ])],
  ['COMPLETED-PLAN.md', new Map([
    ['66:f58e917a656b59e47b5f091c6a95b2747b4621537ddb01ccb56a710e9676211d', '7a7106e4b41c21e2adc92cdf9443a7b94aee572a60ea03884fb465889bc4a5d1'],
    ['107:c1984cbe6209964b0654cac3d52784c93def623946d319a5d7c90e3582cca017', '0b75ea98b6525cb7df81f1a03996bf1854199676b1725148e7746edd60dd7e6d'],
    ['114:d96b796bc127d6a84a394166e10bdfb31f03bf27301ce9f0dba8aad2687a7f3e', 'b920c26b18bb6be3c61ddd7b74337a455dda3f5bcf19ca3847005a5de419856a'],
    ['121:5fec438708e52cf04eda4f079761ac96ebea0277d59a272058baa9b353847ed2', '318171c9a339f4fce010828b107105eb546c47877e8eb58abe0e177be80f478f'],
    ['131:f92f38276200ff605294ed6627dcedc1baaa10bb5e4bcdd63ded6d11d719d4ae', '7a565272b37cf0abb37938fcb0cd0ae887346a12504bfe150c8c90238c7bb324'],
    ['133:e0b805aca195ad326f7a0030a70a4385c96684b7091cd2d5ca799e4db75e1411', '94676aeb2c7a739263bf707d635c04faa287ddce80799235f082f17dbc63ca57'],
    ['146:f8a723d369306d14afa171ad2737b05a7c5dae15c20077a720175bbff24cf2bb', 'c017c9e819988693e56befdde3f994acd0f0b7de5b672c5ce6e407e8f7ca6d5f'],
    ['153:5b409f04f9fc6f6b0987ce7d83bfbea62e2fa5d69b3a6c9cbceaa89391669045', 'f43e050d6b4e34610fbff3c3ded74beb51d237974dfe5274dfcbe55cc643a22f'],
    ['478:fcafe8065a6778989999f31a9d5689dd0e15d06e3e27259e0397d8e92811e7fd', '0597796f1aca70abc6a8af1d82aff18e16039c38f50f0e9a9a3b145ad20d736a'],
    ['523:066ab315defd58c0663fa81d1c4f45c774fb1a8e53d8a79863c691b4f800b398', '50574d8ee239bc24c1760bb907df623bc356a57fe8e2b2fdc2e2ed9255867d4d'],
    ['701:1e2a14ff07af4579d56564c8abf7a939429ab0097b0320820752ea4a93cfa8c9', 'f09a2f177e057d2bce68d06b17f5cbc50a667986ea9f1688687a648720840358'],
    ['714:e6905c78ee946d20139a5337b9a69078ddb9ad15246fb60ffdfbce366e53ee66', '82d998a993cd56600e44bbd356af0f3d95998238e2b73b9ee062627192d37928'],
    ['729:d738d9626dd6e5c074edae15b680d8f15fcc3391390d5f3de0f883cd90e5fefe', '8e69b4e8b362098021671bd62c6a75b493b13d0290a8a16525fcf939430b9af9'],
    ['731:98468ae4a7490c4e50c1498760187629d1a3af6463106961c1118e8e54790981', '39180209c08f636f242280fe3ed537cea0e89b41d5af35e9797b4a6438edce7c'],
  ])],
  ['PLAN.md', new Map([
    ['108:78c881c785e9bdaad88ada9cf48b0a9aa8162e327d41e883d3c522f74abd7577', 'f2c0edc98660985e881c227bad32cfa37bacc4853fa7a2583977047e185fc625'],
    ['138:2ac130087566ec7ed894d950e99bf8d2a725ff4f90fc7593e6460f657c931322', '16ac589b5de73fea3992f1a59ec807d8a537d56a25facccce78ab8cfd3f15394'],
    ['162:403ce4c581ea20d8e45871886ff5bdfd4ec095772f6be43b9315e3aa160ce013', 'd1afb4c691e22ab3f558771faf64ceafc3545f7cdb16a0d019eb2efca306733e'],
  ])],
]);
const digest = line => createHash('sha256').update(line).digest('hex');
const norm = (line) => line.trim().replace(/^#+\s+/, '');
const separator = (line) => /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(line.trim()) || /^[-*_]{3,}$/.test(line.trim());
const walk = (dir) => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []; });
const corpusFiles = ['PLAN.md', 'ARCHITECTURE.md', 'COMPLETED-PLAN.md', ...(existsSync(join(ROOT, '.deckent/docs')) ? walk(join(ROOT, '.deckent/docs')).map(p => p.slice(ROOT.length)) : [])];
const corpus = new Set();
for (const file of corpusFiles) if (existsSync(join(ROOT, file))) for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) corpus.add(norm(line));
let removed = 0; let found = 0; let skipped = 0; let redacted = 0; const missing = [];
for (const file of files) {
  const { stdout } = await runGit('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const old = stdout.split('\n');
  const current = new Set(readFileSync(join(ROOT, file), 'utf8').split('\n').map(norm));
  const approved = privacyReplacements.get(file);
  const currentDigests = approved && new Set([...current].map(digest));
  for (const [index, line] of old.entries()) {
    if (norm(line) === '') continue;
    if (current.has(norm(line))) continue; // still present in the same file
    removed++;
    if (separator(line)) { skipped++; continue; }
    const replacement = approved?.get(`${index + 1}:${digest(line.replace(/\r$/u, ''))}`);
    if (replacement) {
      if (currentDigests.has(replacement)) redacted++;
      else missing.push(`${file}:${index + 1}: authorized privacy replacement is missing`);
      continue;
    }
    if (corpus.has(norm(line))) found++; else missing.push(`${file}:${index + 1}: sha256 ${digest(line.replace(/\r$/u, '')).slice(0, 16)} (removed line not found; text withheld)`);
  }
}
console.log(`removed non-empty lines: ${removed}; found elsewhere: ${found}; separators/rules (no content): ${skipped}; authorized privacy replacements: ${redacted}; not found: ${missing.length}`);
if (verbose || missing.length) for (const m of missing.slice(0, 200)) console.log('  MISSING ' + m);
process.exit(missing.length === 0 ? 0 : 1);
