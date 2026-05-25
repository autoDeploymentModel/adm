use std::path::Path;

pub fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<u32, String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("打开zip文件失败: {}", e))?;
    
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("解析zip文件失败: {}", e))?;
    
    let mut count = 0;
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("读取zip条目失败: {}", e))?;
        
        let outpath = match file.enclosed_name() {
            Some(path) => path.to_owned(),
            None => continue,
        };
        
        let file_name = match outpath.file_name() {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let dest_path = dest_dir.join(file_name);
        
        if file.is_dir() {
            continue;
        }
        
        if let Some(p) = dest_path.parent() {
            std::fs::create_dir_all(p)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
        
        let mut outfile = std::fs::File::create(&dest_path)
            .map_err(|e| format!("创建文件失败: {}", e))?;
        
        std::io::copy(&mut file, &mut outfile)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        
        count += 1;
    }
    
    Ok(count)
}

pub fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<u32, String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("打开tar.gz文件失败: {}", e))?;
    
    let gz_decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz_decoder);
    
    let mut count = 0;
    
    for entry in archive.entries().map_err(|e| format!("读取tar条目失败: {}", e))? {
        let mut entry = entry.map_err(|e| format!("解析tar条目失败: {}", e))?;
        
        let path = entry.path().map_err(|e| format!("获取tar条目路径失败: {}", e))?;
        
        if let Some(name) = path.to_str() {
            if name.contains("__MACOSX") || name.contains(".DS_Store") {
                continue;
            }
        }
        
        let file_name = match path.file_name() {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let dest_path = dest_dir.join(file_name);
        
        if entry.header().entry_type().is_dir() {
            continue;
        }
        
        if let Some(p) = dest_path.parent() {
            std::fs::create_dir_all(p)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
        
        entry.unpack(&dest_path)
            .map_err(|e| format!("解压文件失败: {}", e))?;
        
        count += 1;
    }
    
    Ok(count)
}
