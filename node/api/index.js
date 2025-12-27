const express = require('express')
const app = express()
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const cors = require('cors')

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors()) // 允许所有跨域请求

// ====================== 核心目录配置 ======================
// 分片临时存储目录（按文件夹路径分层）
const chunkDir = path.join(__dirname, '../uploads/chunks')
// 最终文件存储目录（保留文件夹层级）
const uploadDir = path.join(__dirname, '../uploads')
// 自动创建目录（不存在则创建）
;[chunkDir, uploadDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
})

// ====================== Multer 分片存储配置（支持文件夹） ======================
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      // 解析前端参数
      const { identifier, relativePath } = req.body
      // 1. 构建分片存储根目录（按identifier）
      const chunkRootDir = path.join(chunkDir, identifier)
      // 2. 解析文件夹路径（从relativePath中提取，支持多级目录）
      const fileDir = path.dirname(relativePath) // 获取文件所在文件夹路径（如 "docs/videos"）
      const chunkSubDir = path.join(chunkRootDir, fileDir)

      // 3. 递归创建文件夹（支持多级目录）
      if (!fs.existsSync(chunkSubDir)) {
        fs.mkdirSync(chunkSubDir, { recursive: true })
      }

      cb(null, chunkSubDir)
    } catch (error) {
      cb(error, null)
    }
  },
  filename: (req, file, cb) => {
    // 分片文件名：chunk-[分片序号].[原扩展名]（保留原文件名）
    const { chunkNumber, filename } = req.body
    const ext = path.extname(filename)
    const basename = path.basename(filename, ext) // 获取文件名（不含扩展名）
    cb(null, `${basename}-chunk-${chunkNumber}${ext}`)
  }
})

// 分片上传中间件（限制单分片100MB）
const upload = multer({
  storage: chunkStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
})

// ====================== 原有根接口 ======================
app.get('/', (req, res) => {
  console.log(req.query)
  res.send(`Hello World! 您输入的ID为：${req.query.id}`)
})

// ====================== 支持文件夹的分片上传接口 /upload/multiple ======================
app.all('/upload/multiple', upload.single('file'), (req, res) => {
  try {
    // 解析前端传递的分片/文件夹参数
    const { 
      chunkNumber, 
      totalChunks, 
      identifier, 
      filename,
      totalSize,
      chunkSize,
      currentChunkSize,
      relativePath // 关键：文件夹路径（如 "folder1/subfolder/file.mp4"）
    } = req.body

    // 验证必要参数
    if (!identifier || !chunkNumber || !totalChunks || !filename || !relativePath) {
      return res.status(400).json({
        code: -1,
        msg: '缺少必要参数：identifier/chunkNumber/totalChunks/filename/relativePath'
      })
    }

    // 转换为数字类型
    const chunkNum = parseInt(chunkNumber)
    const totalChunkNum = parseInt(totalChunks)
    
    // 检查是否是最后一个分片
    // const isLastChunk = totalChunkNum != 1 ? chunkNum === totalChunkNum : false
    const isLastChunk = chunkNum === totalChunkNum
    
    // 构建当前分片/文件夹信息
    const chunkInfo = {
      originalName: filename,
      relativePath: relativePath, // 保留文件夹路径
      folderPath: path.dirname(relativePath), // 提取文件夹路径
      chunkNumber: chunkNum,
      totalChunks: totalChunkNum,
      chunkSize: parseInt(chunkSize),
      currentChunkSize: parseInt(currentChunkSize),
      totalSize: parseInt(totalSize),
      identifier,
      chunkPath: req.file.path
    }

    console.log(`[${chunkInfo.folderPath}] 分片 ${chunkNum}/${totalChunkNum} 上传成功：`, filename)

    // 返回响应（最后一个分片返回needMerge: true）
    res.json({
      code: 0,
      msg: `[${chunkInfo.folderPath}] 分片 ${chunkNum}/${totalChunkNum} 上传成功`,
      data: chunkInfo,
      needMerge: isLastChunk // 最后一个分片需要合并
    })
  } catch (error) {
    res.status(500).json({
      code: -1,
      msg: '分片/文件夹上传失败：' + error.message
    })
  }
})

// ====================== 支持文件夹的分片合并接口 /upload/merge ======================
app.post('/upload/merge', async (req, res) => {
  try {
    // 接收前端传递的合并参数
    const { identifier, filename, totalChunks, relativePath } = req.body
    // 验证参数
    if (!identifier || !filename || !totalChunks || !relativePath) {
      return res.status(400).json({
        code: -1,
        msg: '合并失败：缺少必要参数（identifier/filename/totalChunks/relativePath）'
      })
    }

    // 1. 解析文件夹路径
    const fileDir = path.dirname(relativePath) // 文件所在文件夹（如 "docs/videos"）
    const fileName = path.basename(filename) // 纯文件名（不含路径）
    const ext = path.extname(filename)

    // 2. 拼接分片目录和最终文件路径（保留文件夹层级）
    const chunkRootDir = path.join(chunkDir, identifier)
    const chunkSubDir = path.join(chunkRootDir, fileDir) // 分片的文件夹路径
    // 最终文件存储路径（按文件夹层级创建）
    const finalFileDir = path.join(uploadDir, fileDir)
    if (!fs.existsSync(finalFileDir)) {
      fs.mkdirSync(finalFileDir, { recursive: true })
    }
    // 最终文件名：时间戳 + 原文件名（避免重复）
    const finalFileName = `${Date.now()}-${path.basename(fileName, ext)}${ext}`
    const finalFilePath = path.join(finalFileDir, finalFileName)

    // 3. 检查分片是否完整
    const totalChunkNum = parseInt(totalChunks)
    const missingChunks = []
    const chunkFiles = []
    const basename = path.basename(fileName, ext)

    for (let i = 1; i <= totalChunkNum; i++) { // 分片序号从1开始
      const chunkPath = path.join(chunkSubDir, `${basename}-chunk-${i}${ext}`)
      if (!fs.existsSync(chunkPath)) {
        missingChunks.push(i)
      } else {
        chunkFiles.push(chunkPath)
      }
    }

    // 分片缺失则返回错误
    if (missingChunks.length > 0) {
      return res.status(400).json({
        code: -1,
        msg: `合并失败：分片 ${missingChunks.join(',')} 缺失`,
        data: { missingChunks, folderPath: fileDir }
      })
    }

    // 4. 流式合并分片（避免大文件内存溢出）
    const writeStream = fs.createWriteStream(finalFilePath)
    for (const chunkPath of chunkFiles) {
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath)
        readStream.pipe(writeStream, { end: false })
        readStream.on('end', () => {
          readStream.destroy()
          resolve()
        })
        readStream.on('error', (err) => {
          reject(`读取分片失败：${err.message}`)
        })
      })
    }
    // 关闭写入流
    writeStream.end()

    // 5. 合并完成后删除临时分片目录（可选，保留则支持断点续传）
    // 仅删除当前文件的分片目录，不删除文件夹层级（避免影响同文件夹其他文件）
    // fs.rmSync(chunkSubDir, { recursive: true, force: true })
    // 如需清理整个identifier的分片：fs.rmSync(chunkRootDir, { recursive: true, force: true })

    // 6. 获取最终文件信息
    const fileStat = fs.statSync(finalFilePath)
    const fileInfo = {
      originalName: filename,
      originalFolderPath: fileDir, // 原始文件夹路径
      fileName: finalFileName,
      fileSize: `${(fileStat.size / 1024 / 1024).toFixed(2)} MB`,
      filePath: path.join(fileDir, finalFileName), // 带文件夹的相对路径
      fullUrl: `http://localhost:3000/uploads/${path.join(fileDir, finalFileName)}`, // 完整访问URL
      identifier
    }

    console.log(`[${fileDir}] 文件合并成功：`, fileInfo)

    // 7. 返回合并结果
    res.json({
      code: 0,
      msg: `[${fileDir}] 文件合并成功`,
      data: fileInfo
    })
  } catch (error) {
    res.status(500).json({
      code: -1,
      msg: '文件夹/文件合并失败：' + error.message
    })
  }
})

// ====================== 静态文件访问（支持文件夹层级访问） ======================
app.use('/uploads', express.static(uploadDir))

// ====================== 启动服务 ======================
app.listen(3000, () => {
  console.log('服务启动成功：http://localhost:3000')
  console.log('接口说明：')
  console.log('  1. 分片/文件夹上传：POST /upload/multiple（表单字段：file + 分片/文件夹参数）')
  console.log('  2. 分片/文件夹合并：POST /upload/merge（参数：identifier/filename/totalChunks/relativePath）')
  console.log('  3. 文件访问：http://localhost:3000/uploads/[文件夹路径]/[文件名]')
})