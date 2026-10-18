use crate::error::{CoreError, Result};
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::writer::Writer;
use std::collections::HashMap;
use std::io::{BufRead, Write};

pub struct StreamingXmltvFilter<'a> {
    channel_mapping: &'a HashMap<String, String>,
}

impl<'a> StreamingXmltvFilter<'a> {
    pub fn new(channel_mapping: &'a HashMap<String, String>) -> Self {
        Self { channel_mapping }
    }

    pub fn filter<R: BufRead, W: Write>(&self, input: R, mut output: W) -> Result<()> {
        let mut reader = Reader::from_reader(input);
        reader.config_mut().trim_text(false);
        let mut writer = Writer::new(&mut output);

        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) if e.name().as_ref() == b"channel" => {
                    let mut new_elem = BytesStart::new("channel");
                    for attr in e.attributes() {
                        let attr = attr.map_err(|e| CoreError::Other(e.to_string()))?;
                        if attr.key.as_ref() == b"id" {
                            let old_id = String::from_utf8_lossy(&attr.value);
                            let target_id = self
                                .channel_mapping
                                .get(old_id.as_ref())
                                .unwrap_or(&old_id.to_string())
                                .clone();
                            new_elem.push_attribute(("id", target_id.as_str()));
                        } else {
                            new_elem.push_attribute(attr);
                        }
                    }
                    writer
                        .write_event(Event::Start(new_elem))
                        .map_err(|e| CoreError::Other(e.to_string()))?;
                }
                Ok(Event::Start(ref e)) if e.name().as_ref() == b"programme" => {
                    let mut new_elem = BytesStart::new("programme");
                    for attr in e.attributes() {
                        let attr = attr.map_err(|e| CoreError::Other(e.to_string()))?;
                        if attr.key.as_ref() == b"channel" {
                            let old_ch = String::from_utf8_lossy(&attr.value);
                            let target_ch = self
                                .channel_mapping
                                .get(old_ch.as_ref())
                                .unwrap_or(&old_ch.to_string())
                                .clone();
                            new_elem.push_attribute(("channel", target_ch.as_str()));
                        } else {
                            new_elem.push_attribute(attr);
                        }
                    }
                    writer
                        .write_event(Event::Start(new_elem))
                        .map_err(|e| CoreError::Other(e.to_string()))?;
                }
                Ok(Event::Eof) => break,
                Ok(e) => {
                    writer
                        .write_event(e)
                        .map_err(|e| CoreError::Other(e.to_string()))?;
                }
                Err(e) => return Err(CoreError::Other(format!("XML parser error: {}", e))),
            }
            buf.clear();
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_streaming_xmltv_filter() {
        let sample_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="sky.de">
    <display-name>Sky Cinema HD</display-name>
  </channel>
  <programme start="20261018200000 +0000" stop="20261018220000 +0000" channel="sky.de">
    <title>Inception</title>
  </programme>
</tv>"#;

        let mut mapping = HashMap::new();
        mapping.insert("sky.de".to_string(), "gecko_sky_de".to_string());

        let filter = StreamingXmltvFilter::new(&mapping);
        let mut output = Vec::new();
        filter
            .filter(sample_xml.as_bytes(), &mut output)
            .expect("Filter should succeed");

        let result_str = String::from_utf8(output).unwrap();
        assert!(result_str.contains("channel id=\"gecko_sky_de\""));
        assert!(result_str.contains("channel=\"gecko_sky_de\""));
        assert!(result_str.contains("Inception"));
    }
}
