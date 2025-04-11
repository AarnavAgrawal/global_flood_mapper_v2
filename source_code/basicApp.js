/*
This is the basic version of the Global Flood Mapper tool

The tool is a part of the article titled:
A novel application for rapid flood mapping using Sentinel-1 SAR data and Google Earth Engine
*/

// Import all the scripts
var aoi_filter = require('users/aarnavagrawal/GlobalFloodMapperV2:aoiFilter');
var mapFloods = require('users/aarnavagrawal/GlobalFloodMapperV2:mapFloods');
var zscorebasic = require('users/aarnavagrawal/GlobalFloodMapperV2:zScoreBasic');
var floodLegend = require('users/aarnavagrawal/GlobalFloodMapperV2:floodLegend');
var generateChart = require('users/aarnavagrawal/GlobalFloodMapperV2:availabilityGraphStacked')
var floodExport = require('users/aarnavagrawal/GlobalFloodMapperV2:floodMapExport');


var ghslPop = ee.Image('JRC/GHSL/P2023A/GHS_POP/2020').select('population_count'); 
var gpwPop = ee.ImageCollection('CIESIN/GPWv411/GPW_UNWPP-Adjusted_Population_Count').first().select('unwpp-adjusted_population_count'); 
var landscanPop = ee.ImageCollection('projects/sat-io/open-datasets/ORNL/LANDSCAN_GLOBAL')
                    .filterDate('2020-01-01', '2020-12-31') 
                    .first()
                    .select('b1'); 


// Set a fixed AOI for the application
// Define a default AOI (India, Bihar)
var aoi = ee.FeatureCollection("FAO/GAUL/2015/level2")
        .filter(ee.Filter.equals('ADM0_NAME', 'India'))
        .filter(ee.Filter.equals('ADM1_NAME', 'Bihar'))
        .geometry();

function updateAoi(level_0, level_1, ret){
  aoi = ee.FeatureCollection("FAO/GAUL/2015/level2")
        .filter(ee.Filter.equals('ADM0_NAME', level_0))
        .filter(ee.Filter.equals('ADM1_NAME', level_1))
        .geometry();
  if (ret === true){
    return(aoi)
  }
}
updateAoi('India', 'Bihar', false)

var country_name = aoi_filter.countries


// Define a default start date
var start_date = [ee.Date('2020-05-01'), ee.Date('2020-07-20')];
var advance_days = [60, 8];

// Modify the function from DeVries to fit the needs
function getFloodImage(s1_collection_t1, s1_collection_t2){
  // Z-score thresholds
  var zvv_thd = -3;
  var zvh_thd = -3;
  var pow_thd = 75;
  
  // Compute Z-scores per instrument mode and orbital direction
  var z_iwasc = zscorebasic.calc_zscore(s1_collection_t1, s1_collection_t2, 'IW');
  
  var z = ee.ImageCollection.fromImages([z_iwasc])
    .sort('system:time_start');
  
  // Run flood mapping algorithm on latest Z-score
  var floods = mapFloods.mapFloods(z.mean(), zvv_thd, zvh_thd, pow_thd);
  
  return(floods.clip(aoi))
}

// Create a function for getting updated Sentinel-1 collection
function getSentinel1WithinDateRange(date, span){
  var filters = [
    ee.Filter.listContains("transmitterReceiverPolarisation", "VV"),
    ee.Filter.listContains("transmitterReceiverPolarisation", "VH"),
    ee.Filter.or(
      ee.Filter.equals("instrumentMode", "IW"),
      ee.Filter.equals("instrumentMode", "SM")
      ),
    ee.Filter.bounds(aoi),
    ee.Filter.eq('resolution_meters', 10),
    ee.Filter.date(date, date.advance(span+1, 'day'))
  ];
  
  var s1_collection = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filter(filters)

  return s1_collection;
}

function createS1Composite(s1_collection){
  var composite = ee.Image.cat([
    s1_collection.select('VH').mean(),
    s1_collection.select('VV').mean(),
    s1_collection.select('VH').mean()
    ]);
    
  return composite.clip(aoi);
}

// Create a function for getting updated Sentinel-2 collection
function maskS2clouds(image) {
  var qa = image.select('QA60');

  // Bits 10 and 11 are clouds and cirrus, respectively.
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;

  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
      .and(qa.bitwiseAnd(cirrusBitMask).eq(0));

  return image.updateMask(mask);
}

function getSentinel2WithinDateRange(date, span){
  var sentinel2 = ee.ImageCollection('COPERNICUS/S2')
                    .filterBounds(aoi)
                    .filterDate(date, date.advance(span+1, 'day'))
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
                    .map(maskS2clouds)
                    .select('B4', 'B3', 'B2');
                    
  return sentinel2.mean().clip(aoi)
}

function calculateAffectedPopulation(floodMap, geometry, resultsPanel) {
  resultsPanel.clear(); 
  resultsPanel.add(ui.Label('Calculating... Please wait.')); 

  var highConfidenceFloodMask = floodMap.eq(3);

  var calculateSum = function(popImage, scale, bandName) {
    var sum = popImage.updateMask(highConfidenceFloodMask)
                     .reduceRegion({
                       reducer: ee.Reducer.sum(),
                       geometry: geometry,
                       scale: scale, 
                       maxPixels: 1e13, 
                       bestEffort: true 
                     });
    return ee.Number(sum.get(bandName)).round(); 
  };

  // Calculate for each dataset
  var ghslSum = calculateSum(ghslPop, 100, 'population_count'); 
  var gpwSum = calculateSum(gpwPop, gpwPop.projection().nominalScale(), 'unwpp-adjusted_population_count'); 
  var landscanSum = calculateSum(landscanPop, landscanPop.projection().nominalScale(), 'b1');


  ee.Dictionary({
    'GHSL (100m)': ghslSum,
    'GPW (~1km)': gpwSum,
    'LandScan (~1km)': landscanSum
  }).evaluate(function(results, error) {
    resultsPanel.clear();
    if (error) {
      print('Population Calculation Error:', error);
      resultsPanel.add(ui.Label('Error calculating population.'));
    } else {
      var createPopulationBarChartFromFeatures = function(results) {
        // Create a feature collection with the population data
        var features = [
          ee.Feature(null, {source: 'GHSL', population: results['GHSL (100m)']}),
          ee.Feature(null, {source: 'GPW', population: results['GPW (~1km)']}),
          ee.Feature(null, {source: 'LandScan', population: results['LandScan (~1km)']})
        ];
        
        var populationFC = ee.FeatureCollection(features);
        
        // Create the chart from the feature collection
        var chart = ui.Chart.feature.byFeature({
          features: populationFC,
          xProperty: 'source',
          yProperties: ['population']
        })
        .setChartType('ColumnChart')
        .setOptions({
          title: 'Affected Population (High Confidence Floods)',
          vAxis: {title: 'Population'},
          hAxis: {title: 'Population Source'},
          legend: {position: 'none'},
          colors: ['#1d6b99']
        });
        
        return chart;
      };
      
      // Replace your existing code with this:
      var populationChart = createPopulationBarChartFromFeatures(results);
      resultsPanel.add(ui.Label('Affected Population (High Confidence Floods):', {fontWeight: 'bold'}));
      resultsPanel.add(populationChart);
    }
  });
}



// Create a function to generate Image dynamically
function getS1Image(index){
  var s1_collection = getSentinel1WithinDateRange(start_date[index], advance_days[index]);
  return createS1Composite(s1_collection);
}

function getS2Image(index){
  return getSentinel2WithinDateRange(start_date[index], advance_days[index]);
}

var s1RawVizParams = {min: [-25, -20, -25], max: [0, 10, 0]}
var s2RawVizParams = {bands: ['B4', 'B3', 'B2'], max: 3048, gamma: 1};
var show_left_sar = true
var show_right_sar = true
var show_left_optical = false
var show_right_optical = false

// Adds a layer selection widget to the given map, to allow users to change
// which image is displayed in the associated map.
function addLayerSelector(mapToChange, defaultValue, position) {
  var panelHeading = (defaultValue == '0') ? 
      ui.Label("Pre-flood panel", {fontSize:'18px', fontWeight:'bold'}) : 
      ui.Label("During-flood panel", {fontSize:'18px', fontWeight:'bold'});
  var label = (defaultValue == '0') ? ui.Label("Pre-flood date range:") : ui.Label("During-flood date range:");
  var show_optical = (defaultValue == '0') ? show_left_optical : show_right_optical
  var show_sar = (defaultValue == '0') ? show_left_sar : show_right_sar
  
  var controlPanel = ui.Panel({style: {position: position, width:'18%'}});
  // Add panel heading
  controlPanel.add(panelHeading)
  // Add text to point towards the chart
  controlPanel.add(
    ui.Label('Data availability chart:',
      {stretch: 'vertical', textAlign: 'left'})
      );
  
  // This function changes the given map to show the selected image.
  function updateMap() {
    mapToChange.layers().set(0, ui.Map.Layer(getS1Image(defaultValue), s1RawVizParams, 'Sentinel-1', show_sar));
    mapToChange.layers().set(1, ui.Map.Layer(getS2Image(defaultValue), s2RawVizParams, 'Sentinel-2', show_optical));
    
    if (defaultValue == 1){
      mapToChange.layers().set(2, ui.Map.Layer(
        getFloodImage(getSentinel1WithinDateRange(start_date[0], advance_days[0]), 
                      getSentinel1WithinDateRange(start_date[1], advance_days[1])), 
        {palette: mapFloods.palette}, 'Flood Map', true));
    }
  }
  
  // Add dropdown for states first so that
  // it can be updated from within country dropdown
  var leftSubPanel1 = ui.Panel({
    layout: ui.Panel.Layout.flow('horizontal'),
    style:{width: '100%'}
  })
  
  // Create drop-downs
  var countryDD = ui.Select({items:[], placeholder:'Loading..', 
    style:{fontSize:'14px', color:'blue', width:'40%', padding:'0px'}})
  var statesDD = ui.Select({items:[], placeholder:'State', 
    style:{fontSize:'14px', color:'blue', width:'40%', padding:'0px'}})

  var countryNames = ee.List(Object.keys(country_name))
  //print(countryNames)
  countryNames.evaluate(function(states){
    countryDD.items().reset(states)
    countryDD.setPlaceholder('Country')
    countryDD.onChange(function(state){
      // once you select a state (onChange) get all counties and fill the dropdown
      statesDD.setPlaceholder('Loading...')
      var counties = ee.List(country_name[state]);
      //print(counties)
      counties.evaluate(function(countiesNames){
        statesDD.items().reset(countiesNames)
        statesDD.setPlaceholder('State')
      })
    })
  })
  statesDD.onChange(function(value){
    updateAoi(countryDD.getValue(), value, false)
    updateBothMapPanel()
  })
  
  // Add drop-downs to the sub-panel
  leftSubPanel1.add(countryDD)
  leftSubPanel1.add(statesDD)

  // Add the date slider for both the maps
  var dateSlider = ui.DateSlider({
    start: ee.Date('2015-01-01'),
    period: 1,
    onChange:function renderedDate(dateRange){
      start_date[defaultValue] = dateRange.start();
      updateMap();
      updateFloodMap()
      updateChart(mapToChange, defaultValue, controlPanel);
    }});
  // Set the default date of the date slider from the actual map dates
  dateSlider = dateSlider.setValue(start_date[defaultValue].format('Y-MM-dd').getInfo());
  
  // Add the text box for users to enter the desired span
  var text_box = ui.Textbox({
    placeholder: "Succeeding days - e.g. "+String(advance_days[defaultValue]),
    onChange: function updateDate(text){
      advance_days[defaultValue] = Number(text);
      updateMap();
      updateFloodMap();
      updateChart(mapToChange, defaultValue, controlPanel);
    }});

  // Set a common title
  var title = ui.Label('Global Flood Mapper',
  {
    stretch: 'horizontal',
    textAlign: 'center',
    fontWeight: 'bold',
    fontSize: '16px'
  });
  
  // use the legend module to create the legend for flood layer
  var legend = floodLegend.legend();
    
  // Add elements to the panel
  controlPanel.add(label)
  controlPanel.add(dateSlider)
  controlPanel.add(text_box)
  
  // Elements specific to left panel
  if(defaultValue == 0){
    var dd_heading = ui.Label("Select area of interest:")
    controlPanel.add(dd_heading)
    controlPanel.add(leftSubPanel1)

    controlPanel.add(
      ui.Button({
        label: 'Select Custom AOI',
        style: {stretch: 'horizontal'},
        onClick: function() {
          leftMap.drawingTools().clear();
          leftMap.drawingTools().setShown(false);
          leftMap.drawingTools().setShape('rectangle');
          leftMap.drawingTools().draw();
          
          leftMap.drawingTools().onDraw(function(geometry){
            leftMap.drawingTools().stop();
            leftMap.drawingTools().clear();
            rightMap.drawingTools().stop();
            rightMap.drawingTools().clear();
            aoi = geometry
            updateBothMapPanel();
          });
          
          rightMap.drawingTools().clear();
          rightMap.drawingTools().setShown(false);
          rightMap.drawingTools().setShape('rectangle');
          rightMap.drawingTools().draw();
          
          rightMap.drawingTools().onDraw(function(geometry){
            rightMap.drawingTools().stop();
            rightMap.drawingTools().clear();
            leftMap.drawingTools().stop();
            leftMap.drawingTools().clear();
            aoi = geometry
            updateBothMapPanel();
          });
          
        }
      })    
    );    
    controlPanel.add(
      ui.Label('Please cite as:',
      {stretch: 'horizontal', textAlign: 'left',
      fontSize:'14px', fontWeight:'bold'}));
    controlPanel.add(
      ui.Label({value: 'Tripathy, P. & Malladi, T. (2022). Global Flood Mapper: a novel Google Earth Engine application for rapid flood mapping using Sentinel‑1 SAR. Natural Hazards. https://doi.org/10.1007/s11069-022-05428-2',
      style: {stretch: 'horizontal', textAlign: 'left',
      fontSize:'14px'}, targetUrl: 'https://doi.org/10.1007/s11069-022-05428-2'}))
  }
  
  // Elements specific to right panel
  if(defaultValue == 1){
    controlPanel.add(
      ui.Label('Download flood map',
      {stretch: 'horizontal', textAlign: 'left',
      fontSize:'16px', fontWeight:'bold'}));
    
    // Create sub-panel to accomodate buttons
    var rightSubPanel1 = ui.Panel({
      layout: ui.Panel.Layout.flow('horizontal', true),
      style:{width: '100%'}})
    var rightSubPanel2 = ui.Panel({
      layout: ui.Panel.Layout.flow('horizontal', true),
      style:{width: '100%'}})
    
    // Add button and link to download flood shapefile
    var shp_label = ui.Label('SHP link', {shown: false});
    var shp_download_button = ui.Button({
      label: 'SHP',
      onClick: function() {
        if (!rightSubPanel1.widgets().contains(shpSmoothingSliderLabel)) {
    
          // Smoothing Radius Slider (affects both smoothing values)
          var shpSmoothingSliderLabel = ui.Label('Smoothing Radius');
          var shpSmoothingSlider = ui.Slider({
            min: 1,
            max: 10,
            value: 3,
            step: 1,
            style: {width: '100%'},
          });
    
          // Cell Size Slider (affects the cell size)
          var shpCellSizeLabel = ui.Label('Cell Size');
          var shpCellSizeSlider = ui.Slider({
            min: 10,
            max: 500,
            value: 100,
            step: 10,
            style: {width: '100%'},
          });
    
          // Confirm Button
          var shpConfirmButton = ui.Button({
            label: 'Confirm',
            onClick: function() {
              var smoothingValue = shpSmoothingSlider.getValue();
              var cellSizeValue = shpCellSizeSlider.getValue();
    
              var flood_image = rightMap.layers().get(2).getEeObject();
              var vector_url = floodExport.getFloodShpUrl(
                flood_image,
                smoothingValue,
                smoothingValue,
                aoi,
                cellSizeValue,
                'GFM_' +
                  start_date[0].format('YYYYMMdd').getInfo() + '_' +
                  start_date[1].format('YYYYMMdd').getInfo() + '_' +
                  aoi.bounds().coordinates().get(0).getInfo()[0][1].toFixed(2) + '_' +
                  aoi.bounds().coordinates().get(0).getInfo()[0][0].toFixed(2) + '_' +
                  aoi.bounds().coordinates().get(0).getInfo()[2][1].toFixed(2) + '_' +
                  aoi.bounds().coordinates().get(0).getInfo()[2][0].toFixed(2) + '_' +
                  cellSizeValue+'m_SR'+smoothingValue
              );
    
              shp_label.setUrl(vector_url);
              shp_label.style().set({shown: true});
              
              shpSmoothingSliderLabel.style().set({shown: false});
              shpSmoothingSlider.style().set({shown: false});
              shpCellSizeLabel.style().set({shown: false});
              shpCellSizeSlider.style().set({shown: false});
              shpConfirmButton.style().set({shown: false});
            }
          });
    
          // Add the sliders and confirm button to the existing right-hand panel
          rightSubPanel1.add(shpSmoothingSliderLabel);
          rightSubPanel1.add(shpSmoothingSlider);
          rightSubPanel1.add(shpCellSizeLabel);
          rightSubPanel1.add(shpCellSizeSlider);
          rightSubPanel1.add(shpConfirmButton);
        }
      }
    });
    
    // Add button and link to download flood PNG map
    var png_label = ui.Label('PNG link', {shown: false});
    var png_download_button = ui.Button({
      label: 'PNG',
      onClick: function(){
        var flood_image = rightMap.layers().get(2).getEeObject();
        var pngToExport = flood_image.visualize({'min':0, 'max':4, 'palette':mapFloods.palette, 'forceRgbOutput':true});
        var png_url = pngToExport.getThumbURL({
          dimensions: 1000,
          region: aoi,
          format: 'png',
        })
        
        png_label.setUrl(png_url);
        png_label.style().set({shown: true});
      }});
    
    // Add button and link to download flood TIFF map
    var tiff_instructions_label = ui.Label('To download, open your terminal and navigate to the desired download directory. Then, copy and paste the command below:', {shown: false});
    var tiff_download_label = ui.Label('TIFF Link', {shown: false});

    var tiff_download_button = ui.Button({
      label: 'TIFF',
      onClick: function() {
        if (!rightSubPanel1.widgets().contains(smoothingSliderLabel)) {
          
          // Smoothing Radius Slider (affects both smoothing values)
          var smoothingSliderLabel = ui.Label('Smoothing Radius');
          var smoothingSlider = ui.Slider({
            min: 1,
            max: 10,
            value: 3,
            step: 1,
            style: {width: '100%'},
          });
    
          // Cell Size Slider (affects the cell size)
          var cellSizeLabel = ui.Label('Cell Size');
          var cellSizeSlider = ui.Slider({
            min: 100,
            max: 700,
            value: 400,
            step: 10,
            style: {width: '100%'},
          });
    
          // Confirm Button
          var confirmButton = ui.Button({
            label: 'Confirm',
            onClick: function() {
              var smoothingValue = smoothingSlider.getValue();
              var cellSizeValue = cellSizeSlider.getValue();
    
              var flood_image = rightMap.layers().get(2).getEeObject();
              var tiff_urls = floodExport.getFloodTiffUrl(
                flood_image,
                smoothingValue,
                smoothingValue,
                aoi,
                cellSizeValue,
                start_date
              );
    
              tiff_instructions_label.style().set({shown: true, stretch: 'horizontal', textAlign: 'left'});
              tiff_download_label.setValue(tiff_urls);
              tiff_download_label.style().set({shown: true, stretch: 'horizontal', textAlign: 'left'});
              
              smoothingSliderLabel.style().set({shown: false});
              smoothingSlider.style().set({shown: false});
              cellSizeLabel.style().set({shown: false});
              cellSizeSlider.style().set({shown: false});
              confirmButton.style().set({shown: false});
            }
          });
          
    
          // Add the sliders and confirm button to the existing right-hand panel
          rightSubPanel1.add(smoothingSliderLabel);
          rightSubPanel1.add(smoothingSlider);
          rightSubPanel1.add(cellSizeLabel);
          rightSubPanel1.add(cellSizeSlider);
          rightSubPanel1.add(confirmButton);
        }
      }
    });
      
    controlPanel.add(
      ui.Label('Generate the download link using the buttons below:',
      {stretch: 'horizontal', textAlign: 'left',
      fontSize:'12px'}));
      
    // Add download buttons and links to right panel
    rightSubPanel1.add(shp_download_button)
    rightSubPanel1.add(png_download_button)
    rightSubPanel1.add(tiff_download_button)
    rightSubPanel2.add(shp_label)
    rightSubPanel2.add(png_label)
    rightSubPanel2.add(tiff_instructions_label)
    rightSubPanel2.add(tiff_download_label)
    controlPanel.add(rightSubPanel1)
    controlPanel.add(rightSubPanel2)
    
    
    // Create panel for population results
    var populationResultsPanel = ui.Panel([], 'flow', {padding: '5px 0px 0px 0px', stretch: 'horizontal'}); // Panel to display results

    // Create the button to trigger population calculation
    var calculatePopButton = ui.Button({
      label: 'Calculate Affected Population (High Confidence)',
      onClick: function() {
        // Get the current flood map layer (assuming it's the 3rd layer [index 2] on the right map)
        // Check layer indices if you have modified the map layers
        var floodLayer;
        try {
           // Inside addLayerSelector, mapToChange refers to the relevant map (rightMap when defaultValue is 1)
           floodLayer = mapToChange.layers().get(2).getEeObject(); // Assumes flood map is layer index 2
        } catch (e) {
           print("Error accessing flood layer. Ensure Flood Map layer is added to the map (index 2).");
           populationResultsPanel.clear();
           populationResultsPanel.add(ui.Label('Error: Flood Map layer not found on map (index 2).'));
           return;
        }

        if (!floodLayer) {
             print("Error: Flood layer object is invalid.");
             populationResultsPanel.clear();
             populationResultsPanel.add(ui.Label('Error: Flood Map layer is invalid.'));
             return;
        }
        // Get the current AOI geometry (using the global 'aoi' variable)
        var currentAoi = aoi;
        calculateAffectedPopulation(floodLayer, currentAoi, populationResultsPanel);
      },
      style: {stretch: 'horizontal', margin: '8px 0px 0px 0px'} // Added margin top
    });

    controlPanel.add(calculatePopButton);       // Add the button to the control panel
    controlPanel.add(populationResultsPanel);   // Add the results panel below the button

  }
  
  // dummy panel to add on the either side
  var dummyPanel = ui.Panel({
    widgets: [], 
    style: {width:'18%'}});
  
  mapToChange.add(legend);
  mapToChange.add(title);
  return [controlPanel, dummyPanel];
}

// Create left and right maps
var leftMap = ui.Map();
leftMap.setControlVisibility(true);

var rightMap = ui.Map();
rightMap.setControlVisibility(true);

var left_panel = addLayerSelector(leftMap, 0, 'middle-left');
var left_dummy = left_panel[1];
left_panel = left_panel[0];

var right_panel = addLayerSelector(rightMap, 1, 'middle-right');
var right_dummy = right_panel[1];
right_panel = right_panel[0];

var main_panel = [left_panel, right_panel]

// Create a function that takes the checkbox boolean
// value of the two layers of both the maps and updates
// the variable. This function will be called before the 
// updateMap funtion.
function updateVisibility(){
  // Use the checkbox information to update the layers
  // in both the maps. 0 is SAR, 1 is optical.  
  show_left_sar = leftMap.layers().get(0).getShown()
  show_right_sar = rightMap.layers().get(0).getShown()
  
  show_left_optical = leftMap.layers().get(1).getShown()
  show_right_optical = rightMap.layers().get(1).getShown()
}

// This function is called when maps need to be refreshed
function updateBothMapPanel(){
  updateVisibility()
  updateChart(leftMap, 0, left_panel);
  updateChart(rightMap, 1, right_panel);
  
  // Add Sentinel-1 images to both the maps
  leftMap.layers().set(0, ui.Map.Layer(getS1Image(0),s1RawVizParams, 'Sentinel-1', show_left_sar));
  rightMap.layers().set(0, ui.Map.Layer(getS1Image(1),s1RawVizParams, 'Sentinel-1', show_right_sar));
  
  // Add Sentinel-2 images to both the maps  
  leftMap.layers().set(1, ui.Map.Layer(getS2Image(0),s2RawVizParams, 'Sentinel-2', show_left_optical));
  rightMap.layers().set(1, ui.Map.Layer(getS2Image(1),s2RawVizParams, 'Sentinel-2', show_right_optical));
  
  // Update the flood map
  updateFloodMap()

  leftMap.centerObject(aoi)
}

// Update flood map
function updateFloodMap(){
  rightMap.layers().set(2, ui.Map.Layer(
        getFloodImage(getSentinel1WithinDateRange(start_date[0], advance_days[0]), 
                      getSentinel1WithinDateRange(start_date[1], advance_days[1])), 
        {palette: mapFloods.palette}, 'Flood Map', true));
}

// Update availability graph
function updateChart(map, defaultValue, controlPanel){
  var chart = generateChart.generateCollectionChart(
    getSentinel1WithinDateRange(start_date[defaultValue], advance_days[defaultValue])
    )
  
  // If you are adding widgets before the chart,
  // you will need to update the numbers below.
  if (map.widgets().length()>1){
    main_panel[defaultValue].widgets().set(2, chart)
  }else{
    controlPanel.add(chart)
  }
  
  
}

// Create panels for left and right sides
var leftPiece = ui.Panel(
  [
    main_panel[0],
    leftMap,
    left_dummy
    ],
    ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});
var rightPiece = ui.Panel(
  [
    right_dummy,
    rightMap,
    main_panel[1]
    ],
    ui.Panel.Layout.Flow('horizontal'), {stretch: 'both'});

// Create a SplitPanel to hold the adjacent, linked maps.
var splitPanel = ui.SplitPanel({
  firstPanel: leftPiece,
  secondPanel: rightPiece,
  wipe: true,
  style: {stretch: 'both'}
});

// Set the SplitPanel as the only thing in the UI root.
function refresh(){
  ui.root.widgets().reset([splitPanel]);
}
refresh();

// Link the maps so they move together
var linker = ui.Map.Linker([leftMap, rightMap]);


// Initialize both maps with content
updateBothMapPanel();

// Center on the default AOI
leftMap.centerObject(aoi, 8);

