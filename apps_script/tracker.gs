function doGet(e) {
  var params = e.parameter || {};
  var type = params.t || '';
  var campaignId = params.c || '';
  var recipient = params.r || '';
  var target = params.u || '';

  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  var sheetName = PropertiesService.getScriptProperties().getProperty('SHEET_NAME') || 'Analytics';

  try {
    if (sheetId) {
      var ss = SpreadsheetApp.openById(sheetId);
      var sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      sh.appendRow([new Date(), type, campaignId, recipient, target]);
    }
  } catch (err) {}

  if (type === 'click' && target) {
    return HtmlService.createHtmlOutput('<html><head><meta http-equiv="refresh" content="0;url=' + encodeURI(target) + '" /></head><body></body></html>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // 1x1 transparent GIF
  var blob = Utilities.newBlob('\u0000', 'image/gif');
  return ContentService.createBinaryOutput(blob.getBytes())
    .setMimeType(ContentService.MimeType.GIF);
}

