module.exports = {
  ...require('./src/engine'),
  ...require('./src/sort-weight'),
  layer1: require('./src/layer1-gtm'),
  layer2: require('./src/layer2-ga4'),
  layer3: require('./src/layer3-fire'),
  layer4: require('./src/layer4-ads'),
  layer5: require('./src/layer5-live'),
};
